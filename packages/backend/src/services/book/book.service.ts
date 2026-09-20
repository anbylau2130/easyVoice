import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { AUDIO_DIR } from '../../config'
import { logger } from '../../utils/logger'
import { asyncSleep, ensureDir, getLangConfig, readJson } from '../../utils'
import { generateTTS, TtsProgressCallback } from '../tts.service'
import { planCharacterVoices, CharacterVoice } from '../../llm/segmentParser'
import { listVoicePresets } from '../voicePreset.service'
import { listCustomVoices } from '../customVoice.service'
import type { ParsedChapter } from './chapter.service'

export interface BookParams {
  voice: string
  rate: string
  pitch: string
  volume: string
  useLLM: boolean
}

export type ChapterStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped'

export interface BookChapter {
  index: number
  title: string
  charCount: number
  status: ChapterStatus
  audioFile?: string
  srtFile?: string
  error?: string | null
  /** 片段级进度 0-100（仅 processing 阶段有意义） */
  progress?: number
  /** 本章开始生成的时间（ISO），用于前端显示已用时 */
  startedAt?: string
}

export interface Book {
  id: string
  title: string
  status: 'running' | 'paused' | 'completed'
  params: BookParams
  chapters: BookChapter[]
  createdAt: string
  updatedAt: string
  /** AI 模式：全书统一的角色-音色映射（首次生成前规划一次） */
  characterVoices?: CharacterVoice[]
  /** AI 模式：正在规划角色音色 */
  planning?: boolean
  /** 书级别的提示信息（如规划失败原因） */
  message?: string
}

const BOOKS_DIR = path.resolve(AUDIO_DIR, 'books')
/** 全局单本锁：同一时刻只生成一本 */
const runningIds = new Set<string>()
/** 暂停请求：当前章节完成后生效（章节边界粒度） */
const pauseRequested = new Set<string>()
/** 正在规划角色音色的书 */
const planningIds = new Set<string>()

const BOOK_ID_PATTERN = /^[\w-]+$/

/** 全量声音列表（音色编辑时校验用） */
async function allVoiceNames(): Promise<string[]> {
  const voicePath = path.resolve(__dirname, '../../llm/prompt/voice.json')
  const list = await readJson<{ Name: string }[]>(voicePath)
  return list.map((v) => v.Name).filter(Boolean)
}

function bookDir(id: string): string {
  return path.resolve(BOOKS_DIR, id)
}

function bookMetaFile(id: string): string {
  return path.join(bookDir(id), 'book.json')
}

async function saveBook(book: Book): Promise<void> {
  book.updatedAt = new Date().toISOString()
  await fs.writeFile(bookMetaFile(book.id), JSON.stringify(book, null, 2), 'utf-8')
}

export async function loadBook(id: string): Promise<Book | null> {
  if (!BOOK_ID_PATTERN.test(id)) return null
  try {
    // 只读元数据：章节正文单独存放在 chapters/<i>.txt，
    // 列表/详情/轮询等高频调用不应把全书正文读进内存
    return JSON.parse(await fs.readFile(bookMetaFile(id), 'utf-8')) as Book
  } catch {
    return null
  }
}

export async function readChapterContent(id: string, index: number): Promise<string> {
  try {
    return await fs.readFile(path.join(bookDir(id), 'chapters', `${index}.txt`), 'utf-8')
  } catch {
    return ''
  }
}

async function saveChapterContent(id: string, index: number, content: string): Promise<void> {
  await ensureDir(path.join(bookDir(id), 'chapters'))
  await fs.writeFile(
    path.join(bookDir(id), 'chapters', `${index}.txt`),
    content,
    'utf-8'
  )
}

function isChapterRunnable(chapter: BookChapter): boolean {
  return chapter.status !== 'done' && chapter.status !== 'skipped'
}

export function computeBookStatus(book: Book): Book['status'] {
  const runnable = book.chapters.filter((c) => c.status !== 'skipped')
  if (!runnable.length) return 'completed'
  return runnable.every((c) => c.status === 'done') ? 'completed' : 'paused'
}

export function generateBookId(title: string, chapters: ParsedChapter[]): string {
  const hash = crypto.createHash('sha256')
  hash.update(title)
  for (const chapter of chapters) {
    hash.update(chapter.title)
    hash.update(String(chapter.content.length))
  }
  return `book-${hash.digest('hex').slice(0, 16)}`
}

/** 创建有声书：写入元数据与章节正文，可选立即开始生成 */
export async function createBook({
  title,
  chapters,
  params,
  autostart = true,
}: {
  title: string
  chapters: (ParsedChapter & { include?: boolean })[]
  params: BookParams
  autostart?: boolean
}): Promise<Book> {
  const cleanChapters = chapters.filter((c) => c.content?.trim())
  if (!cleanChapters.length) throw new Error('至少需要一个非空章节')

  const id = generateBookId(title, cleanChapters)
  if (await loadBook(id)) {
    throw new Error('该有声书已存在，可直接在列表中继续生成')
  }

  const dir = bookDir(id)
  await ensureDir(dir)
  await ensureDir(path.join(dir, 'chapters'))

  const book: Book = {
    id,
    title,
    status: 'paused',
    params,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chapters: [],
  }
  for (let index = 0; index < cleanChapters.length; index++) {
    const chapter = cleanChapters[index]
    await saveChapterContent(id, index, chapter.content)
    book.chapters.push({
      index,
      title: chapter.title || `第${index + 1}章`,
      charCount: chapter.content.length,
      status: chapter.include === false ? 'skipped' : 'pending',
    })
  }
  await saveBook(book)
  logger.info(`Book created: ${id} (${book.chapters.length} chapters)`)
  if (autostart) {
    if (params.useLLM) {
      // AI 模式必须先规划角色音色并经用户确认，不能自动开始生成
      logger.info(`AI mode: skip autostart for ${id}, waiting for character voice planning`)
    } else {
      await startBook(id)
    }
  }
  return book
}

/**
 * 启动/续传生成循环：校验并占用单本锁后立即返回，循环在后台执行。
 * done/skipped 跳过，processing/failed/pending 重跑。
 */
export async function startBook(id: string): Promise<void> {
  if (!BOOK_ID_PATTERN.test(id)) throw new Error('无效的有声书 ID')
  if (runningIds.size > 0) {
    throw new Error('已有有声书正在生成中，请等待完成或暂停后再试')
  }
  // 同步占位锁：check 与 add 之间存在 await，占位才能挡住并发请求
  runningIds.add(id)
  try {
    const book = await loadBook(id)
    if (!book) throw new Error('有声书不存在')
    if (book.params.useLLM && !book.characterVoices?.length) {
      throw new Error('请先生成角色音色规划，再开始生成有声书')
    }

    pauseRequested.delete(id)
    book.status = 'running'
    book.message = undefined
    await saveBook(book)
    logger.info(`Book generation started: ${id}`)
    void runBookLoop(book).catch((err) => {
      logger.error(`Book ${id} generation crashed: ${(err as Error).message}`)
    })
  } catch (err) {
    runningIds.delete(id)
    throw err
  }
}

async function runBookLoop(book: Book): Promise<void> {
  try {
    const characterVoices = book.characterVoices

    for (const chapter of book.chapters) {
      if (pauseRequested.has(book.id)) break
      if (!isChapterRunnable(chapter)) continue
      // 正文按需读取：每章处理时才读对应文件
      const content = await readChapterContent(book.id, chapter.index)
      if (!content.trim()) {
        chapter.status = 'failed'
        chapter.error = '章节内容为空'
        await saveBook(book)
        continue
      }
      chapter.status = 'processing'
      chapter.error = null
      chapter.progress = 0
      chapter.startedAt = new Date().toISOString()
      await saveBook(book)

      // 不设章节超时（按需求等待完成而非砍掉）：
      // 失败仍由底层重试与错误抛出处理，失败章节可随时一键重试
      try {
        let lastProgressSave = 0
        const result = await generateTTS(
          {
            text: content,
            voice: book.params.voice,
            rate: book.params.rate,
            pitch: book.params.pitch,
            volume: book.params.volume,
            useLLM: book.params.useLLM,
          },
          undefined,
          (done: number, total: number) => {
            chapter.progress = total ? Number(((done / total) * 100).toFixed(1)) : 0
            // 进度写盘节流（≤1 次/秒）：updatedAt 同时充当"仍在工作"的活动信号
            const now = Date.now()
            if (now - lastProgressSave > 1000) {
              lastProgressSave = now
              void saveBook(book).catch(() => {})
            }
          },
          characterVoices
        )
        if (result.partial) {
          chapter.status = 'failed'
          chapter.error = '部分片段生成失败，本章音频可能不完整，可重试'
        } else {
          await moveChapterArtifacts(book.id, chapter, result.audio, result.srt)
          chapter.status = 'done'
          chapter.progress = 100
        }
      } catch (err) {
        chapter.status = 'failed'
        chapter.error = (err as Error).message
        logger.error(
          `Chapter ${chapter.index} of book ${book.id} failed: ${(err as Error).message}`
        )
      }
      await saveBook(book)
      // 每章完成后兜底清扫根目录旧产物，保持输出目录整洁
      await cleanStaleRootArtifacts()
    }
  } finally {
    runningIds.delete(book.id)
    pauseRequested.delete(book.id)
    book.status = computeBookStatus(book)
    await saveBook(book)
    logger.info(`Book generation finished: ${book.id} -> ${book.status}`)
  }
}

/** generateTTS 产物在 AUDIO_DIR 根目录，移动到书的 chapters/ 下并改为稳定命名 */
async function moveChapterArtifacts(
  id: string,
  chapter: BookChapter,
  audioUrl: string,
  srtUrl: string
): Promise<void> {
  const audioBase = decodeURIComponent(audioUrl.split('/').pop() || '')
  const srtBase = decodeURIComponent(srtUrl.split('/').pop() || '')
  const chaptersDir = path.join(bookDir(id), 'chapters')
  await ensureDir(chaptersDir)
  const audioTarget = path.join(chaptersDir, `${chapter.index}.mp3`)
  const srtTarget = path.join(chaptersDir, `${chapter.index}.srt`)
  try {
    await fs.rename(path.resolve(AUDIO_DIR, audioBase), audioTarget)
  } catch {
    // 源文件可能已被缓存复用移动过，直接校验目标
  }
  await fs.access(audioTarget)
  chapter.audioFile = `chapters/${chapter.index}.mp3`

  // 短章节的 srt 由 setTimeout 延迟写出，最多等待 3 秒再移动；等不到则不标记 srtFile
  let srtReady = false
  for (let attempt = 0; attempt < 15 && !srtReady; attempt++) {
    try {
      await fs.rename(path.resolve(AUDIO_DIR, srtBase), srtTarget)
      srtReady = true
    } catch {
      await asyncSleep(200)
    }
  }
  if (srtReady) {
    chapter.srtFile = `chapters/${chapter.index}.srt`
  } else {
    logger.warn(`Chapter ${chapter.index} of book ${id}: srt not found after wait, skip srtFile`)
  }

  // 清理本次生成在 AUDIO_DIR 根目录留下的临时目录与字幕中间文件，保持根目录整洁
  await fs.rm(path.resolve(AUDIO_DIR, audioBase.replace(/\.mp3$/, '')), {
    recursive: true,
    force: true,
  })
  await fs.rm(path.resolve(AUDIO_DIR, `${audioBase}.json`), { force: true })
}

/** 暂停：当前章节完成后停止 */
export async function pauseBook(id: string): Promise<string> {
  if (!runningIds.has(id)) {
    const book = await loadBook(id)
    if (!book) throw new Error('有声书不存在')
    if (book.status === 'running') {
      // 进程内状态丢失（如重启残留），直接纠正为暂停
      book.status = 'paused'
      book.chapters.forEach((c) => {
        if (c.status === 'processing') c.status = 'pending'
      })
      await saveBook(book)
    }
    return '有声书未在生成中'
  }
  pauseRequested.add(id)
  return '将在当前章节完成后暂停'
}

/** 续传：processing/failed/pending 章节按序重跑 */
export async function resumeBook(id: string): Promise<void> {
  const book = await loadBook(id)
  if (!book) throw new Error('有声书不存在')
  book.chapters.forEach((c) => {
    if (c.status === 'processing') c.status = 'pending'
  })
  await saveBook(book)
  await startBook(id)
}

/** 仅重跑失败章节 */
export async function retryFailedChapters(id: string): Promise<void> {
  const book = await loadBook(id)
  if (!book) throw new Error('有声书不存在')
  const hasFailed = book.chapters.some((c) => c.status === 'failed')
  if (!hasFailed) throw new Error('没有失败的章节')
  await startBook(id)
}

export interface BookSummary {
  id: string
  title: string
  status: Book['status']
  total: number
  done: number
  failed: number
  /** 书的输出目录（绝对路径） */
  dir: string
  createdAt: string
  updatedAt: string
}

function toSummary(book: Book): BookSummary {
  return {
    id: book.id,
    title: book.title,
    status: book.status,
    total: book.chapters.filter((c) => c.status !== 'skipped').length,
    done: book.chapters.filter((c) => c.status === 'done').length,
    failed: book.chapters.filter((c) => c.status === 'failed').length,
    dir: bookDir(book.id),
    createdAt: book.createdAt,
    updatedAt: book.updatedAt,
  }
}

export async function listBooks(): Promise<BookSummary[]> {
  let entries: string[] = []
  try {
    entries = await fs.readdir(BOOKS_DIR)
  } catch {
    return []
  }
  const summaries: BookSummary[] = []
  for (const entry of entries) {
    if (!BOOK_ID_PATTERN.test(entry)) continue
    const book = await loadBook(entry)
    if (book) summaries.push(toSummary(book))
  }
  return summaries.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

/** 进程启动时调用：上次运行中/处理中的状态纠正为可续传 */
export async function initBookService(): Promise<void> {
  const books = await listBooks()
  for (const summary of books) {
    if (summary.status !== 'running') continue
    const book = await loadBook(summary.id)
    if (!book) continue
    book.status = 'paused'
    book.chapters.forEach((c) => {
      if (c.status === 'processing') c.status = 'pending'
    })
    await saveBook(book)
    logger.info(`Book ${summary.id} was interrupted, marked as paused for resume`)
  }
}

export function chapterFilePath(id: string, index: number, ext: string): string {
  return path.join(bookDir(id), 'chapters', `${index}${ext}`)
}

/**
 * 删除有声书：连同本地书目录（book.json、章节音频、字幕、正文）一起删除。
 * 生成中的书不可删除（先暂停，当前章节完成后即可删除）。
 */
export async function deleteBook(id: string): Promise<void> {
  if (!BOOK_ID_PATTERN.test(id)) throw new Error('无效的有声书 ID')
  if (runningIds.has(id)) throw new Error('有声书正在生成中，请先暂停后再删除')
  const book = await loadBook(id)
  if (!book) throw new Error('有声书不存在')
  await fs.rm(bookDir(id), { recursive: true, force: true })
  logger.info(`Book deleted: ${id} (${book.title})`)
}

/** 书的输出目录（绝对路径），供前端展示 */
export function bookOutputDir(id: string): string {
  return bookDir(id)
}

/**
 * 更新章节选择：indexes 中的章节设为待生成，其余未开始章节设为跳过；
 * 已完成章节不受影响。生成中的书不可修改。
 */
export async function updateChapterSelection(id: string, indexes: number[]): Promise<Book> {
  if (!BOOK_ID_PATTERN.test(id)) throw new Error('无效的有声书 ID')
  if (runningIds.has(id)) throw new Error('有声书正在生成中，不能修改章节选择')
  const book = await loadBook(id)
  if (!book) throw new Error('有声书不存在')
  const wanted = new Set(indexes)
  for (const c of book.chapters) {
    if (c.status === 'done') continue
    c.status = wanted.has(c.index) ? 'pending' : 'skipped'
  }
  book.status = computeBookStatus(book)
  await saveBook(book)
  return book
}

/**
 * 独立的角色音色规划：AI 通读书籍样本，按角色性格分配音色（异步执行，前端轮询 planning 状态）。
 * 规划完成后用户可在角色音色表中试听/编辑，确认后再开始生成有声书。
 */
export async function planBookVoices(id: string): Promise<void> {
  if (!BOOK_ID_PATTERN.test(id)) throw new Error('无效的有声书 ID')
  if (planningIds.has(id)) throw new Error('角色音色正在规划中，请稍候')
  if (runningIds.has(id)) throw new Error('有声书正在生成中，请先暂停后再规划')
  const book = await loadBook(id)
  if (!book) throw new Error('有声书不存在')
  if (!book.params.useLLM) throw new Error('预设声音模式无需规划角色音色')

  planningIds.add(id)
  book.planning = true
  book.message = undefined
  await saveBook(book)
    void (async () => {
      try {
        // 采样正文（每章开头拼接，最多约 5000 字）覆盖主要角色
        let sample = ''
        for (const chapter of book.chapters) {
          if (sample.length >= 5000) break
          const content = await readChapterContent(book.id, chapter.index)
          sample += content.slice(0, 800) + '\n'
        }
        const { lang, voiceList } = await getLangConfig(sample || book.title)
        const customVoices = await listCustomVoices()
        // 自定义 Edge 音色预设作为候选：并入 voiceList（带性别供 AI 匹配）并加入 extraVoices（不受语言过滤限制）
        const presets = await listVoicePresets()
        const presetVoiceEntries = presets.map((p) => ({
          Name: p.id,
          Gender: p.gender || '',
          ContentCategories: ['自定义'],
          VoicePersonalities: [p.voice],
        }))
        book.characterVoices = await planCharacterVoices({
          lang,
          voiceList: [...voiceList, ...presetVoiceEntries],
          sampleText: sample,
          extraVoices: [
            ...customVoices.map((v) => v.voice),
            ...presets.map((p) => p.id),
          ],
          // 用户在创建时选择的音色作为旁白基准
          narratorVoice: book.params.voice,
        })
        logger.info(
          `Character voices planned for book ${id}: ${book.characterVoices
            .map((c) => c.character)
            .join(', ')}`
        )
      } catch (err) {
        book.message = `角色音色规划失败：${(err as Error).message}`
        logger.error(`Character planning failed for book ${id}: ${(err as Error).message}`)
      } finally {
        book.planning = false
        await saveBook(book).catch(() => {})
        planningIds.delete(id)
      }
    })()
  }

/**
 * 保存用户编辑后的角色音色映射。校验音色必须存在于 voice.json；
 * 生成中的书不可修改。description 从既有映射中保留。
 */
export async function saveCharacterVoices(
  id: string,
  characters: { character: string; voice: string }[]
): Promise<void> {
  const book = await loadBook(id)
  if (!book) throw new Error('有声书不存在')
  if (runningIds.has(id)) throw new Error('有声书正在生成中，不能修改角色音色')
  if (!book.params.useLLM) throw new Error('预设声音模式无需角色音色')
  if (!characters.length) throw new Error('角色列表不能为空')

  const validVoices = new Set([
    ...(await allVoiceNames()),
    ...(await listCustomVoices()).map((v) => v.voice),
    ...(await listVoicePresets()).map((p) => p.id),
  ])
  const existing = new Map((book.characterVoices || []).map((c) => [c.character, c] as const))
  const seen = new Set<string>()
  const merged: CharacterVoice[] = []
  for (const item of characters) {
    const character = item.character?.trim()
    if (!character || seen.has(character)) continue
    const voice = item.voice?.trim()
    if (!voice || !validVoices.has(voice)) {
      throw new Error(`角色「${character}」的音色无效：${voice || '为空'}`)
    }
    seen.add(character)
    merged.push({
      character,
      voice,
      gender: existing.get(character)?.gender,
      description: existing.get(character)?.description,
    })
  }
  if (!merged.length) throw new Error('角色列表不能为空')
  book.characterVoices = merged
  await saveBook(book)
  logger.info(`Character voices updated for book ${id}: ${merged.length} characters`)
}

/**
 * 兜底清扫：AUDIO_DIR 根目录是各条生成路径的公共工作区，
 * 多段/重试/异常路径可能残留中间产物；每章完成后清理超过 30 分钟的旧产物。
 * books/（书目录）、.cache/（音频缓存）、custom-voices/（用户上传的克隆参考音频）永久保留。
 */
const PRESERVED_ROOT_ENTRIES = new Set(['books', '.cache', 'custom-voices'])

export async function cleanStaleRootArtifacts(maxAgeMs = 30 * 60_000): Promise<void> {
  try {
    const entries = await fs.readdir(AUDIO_DIR)
    const now = Date.now()
    await Promise.all(
      entries
        .filter((name) => !PRESERVED_ROOT_ENTRIES.has(name))
        .map(async (name) => {
          try {
            const stat = await fs.stat(path.resolve(AUDIO_DIR, name))
            if (now - stat.mtimeMs > maxAgeMs) {
              await fs.rm(path.resolve(AUDIO_DIR, name), { recursive: true, force: true })
              logger.info(`Cleaned stale artifact: ${name}`)
            }
          } catch {
            // 单个条目清理失败不影响整体
          }
        })
    )
  } catch {
    // audio 目录不存在等场景忽略
  }
}
