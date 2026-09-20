import crypto from 'crypto'
import path from 'path'
import fs from 'fs/promises'
import { AUDIO_DIR } from '../../config'
import { logger } from '../../utils/logger'
import { asyncSleep, ensureDir, getLangConfig, readJson, safeRunWithRetry } from '../../utils'
import { openai } from '../../utils/openai'
import { generateTTS, TtsProgressCallback } from '../tts.service'
import {
  planCharacterVoices,
  surveyBookCharacters,
  describeCharacters,
  assignVoicesByPersonality,
  parseJsonLoose,
  CharacterStat,
  CharacterVoice,
} from '../../llm/segmentParser'
import { extractSegmentArray } from '../../llm/segmentParser'
import { listVoicePresets, saveVoicePreset } from '../voicePreset.service'
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
  /** AI 模式：规划进度描述（如"正在通读第 12/60 章"） */
  planningDetail?: string
  /** AI 模式：本轮规划开始时间（前端据此显示已用时） */
  planningStartedAt?: string
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
/** 用户请求停止的规划（下一章边界生效） */
const planningCanceled = new Set<string>()

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

// 书籍元数据写入队列：进度更新/状态变更可能高频并发触发 saveBook，
// 必须按书串行化，否则并发 writeFile 会互相交错导致 book.json 损坏
const saveQueues = new Map<string, Promise<void>>()

async function saveBook(book: Book): Promise<void> {
  book.updatedAt = new Date().toISOString()
  const data = JSON.stringify(book, null, 2)
  const file = bookMetaFile(book.id)
  // 先写临时文件再原子改名：并发读方（轮询/详情）永远不会看到写了一半的 JSON
  const write = async () => {
    const tmp = `${file}.tmp`
    await fs.writeFile(tmp, data, 'utf-8')
    await fs.rename(tmp, file)
  }
  const prev = saveQueues.get(book.id) || Promise.resolve()
  const next = prev.then(write, write)
  saveQueues.set(book.id, next)
  await next.catch(() => {})
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
  /** 该书是否正在规划角色音色 */
  planning?: boolean
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
    planning: !!book.planning,
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
  // 清理遗留的"规划中"标志：规划任务在内存中，服务重启后不可能还在进行
  for (const summary of books) {
    if (!summary.planning) continue
    const book = await loadBook(summary.id)
    if (!book?.planning) continue
    book.planning = false
    book.planningDetail = undefined
    book.planningStartedAt = undefined
    await saveBook(book)
    logger.info(`Book ${summary.id} had stale planning flag (server restarted), cleared`)
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
/** 请求停止规划：在下一章边界生效（当前章会读完）。
 *  若规划任务已不存在但书上仍挂着 planning 标志（如服务重启导致的中断），
 *  直接清理遗留状态并按已受理返回，保证"停止"按钮永远能把书解卡。 */
export function stopPlanVoices(id: string): boolean {
  if (!BOOK_ID_PATTERN.test(id)) throw new Error('无效的有声书 ID')
  if (!planningIds.has(id)) {
    // 兜底：清理遗留标志（服务重启/任务丢失导致的僵尸"规划中"状态）
    ;(async () => {
      const book = await loadBook(id)
      if (book?.planning) {
        book.planning = false
        book.planningDetail = undefined
        book.planningStartedAt = undefined
        await saveBook(book)
        logger.info(`Cleared stale planning flag for book ${id}`)
      }
    })()
    return false
  }
  planningCanceled.add(id)
  logger.info(`Character planning stop requested for book ${id}`)
  return true
}

export async function planBookVoices(
  id: string,
  assignMode: 'match' | 'generate' = 'match'
): Promise<void> {
  if (!BOOK_ID_PATTERN.test(id)) throw new Error('无效的有声书 ID')
  if (planningIds.has(id)) throw new Error('角色音色正在规划中，请稍候')
  if (runningIds.has(id)) throw new Error('有声书正在生成中，请先暂停后再规划')
  const book = await loadBook(id)
  if (!book) throw new Error('有声书不存在')
  if (!book.params.useLLM) throw new Error('预设声音模式无需规划角色音色')

  planningIds.add(id)
  book.planning = true
  book.planningStartedAt = new Date().toISOString()
  book.message = undefined
  planningCanceled.delete(id)
  await saveBook(book)
    void (async () => {
      // 长流程期间角色表/标志位可能被并发更新（用户手动改音色等），
      // 所有写入都必须"重读最新书 → 修改 → 保存"，禁止用外层过期对象直接覆盖
      const update = async (mutate: (b: Book) => void) => {
        const fresh = await loadBook(id)
        if (!fresh) return
        mutate(fresh)
        await saveBook(fresh)
      }
      const setDetail = (detail: string) => update((b) => { b.planningDetail = detail })
      try {
        // 通读全书：逐章调用 AI 做人物普查（串行、进度按章推进）。
        // 每章一次调用保证进度可见；章与章之间有间隔与 429 退避，避免限速失败
        await setDetail('正在读取全书章节…')
        const chapterTexts = book.chapters.map((chapter, i) => ({
          content: '',
          label: `第 ${i + 1}/${book.chapters.length} 章`,
        }))
        for (let i = 0; i < book.chapters.length; i++) {
          chapterTexts[i].content = await readChapterContent(book.id, book.chapters[i].index)
        }
        const langProbe =
          chapterTexts.find((t) => t.content && t.content.length > 100)?.content.slice(0, 2000) ||
          book.title
        const { lang, voiceList } = await getLangConfig(langProbe)
        // 角色音色只从用户配置的 Edge 预设中选取（系统音色不参与 AI 分配）。
        // excludeFromAI 的特殊预设（方言/港台腔）不进入 AI 候选，仅供手动选用
        const presets = (await listVoicePresets()).filter((p) => !p.excludeFromAI)
        const candidateVoiceList = presets.map((p) => ({
          Name: p.id,
          Gender: p.gender || '',
          ContentCategories: ['自定义'],
          VoicePersonalities: [p.voice],
        }))
        // 用户还没有任何预设时，回落到系统 zh-CN 音色，保证规划功能可用
        if (!candidateVoiceList.length) {
          candidateVoiceList.push(
            ...voiceList
              .filter((v) => v.Name.startsWith('zh-CN'))
              .map((v) => ({
                Name: v.Name,
                Gender: v.Gender || '',
                ContentCategories: v.ContentCategories || [],
                VoicePersonalities: v.VoicePersonalities || [],
              }))
          )
        }
        // 旁白基准音色：用户创建时选择的音色若为 Edge 预设则沿用，否则用首个预设音色
        const narratorBase = candidateVoiceList.some((v) => v.Name === book.params.voice)
          ? book.params.voice
          : candidateVoiceList[0]?.Name || book.params.voice
        // 按性别轮转的默认音色：新角色登记时立即预分配（仅使用 Edge 预设池），用户可随时在角色表里改
        const voiceCursor = new Map<string, number>()
        const pickVoice = (gender?: string) => {
          const pool = candidateVoiceList.filter((v) => {
            if (!gender || gender === 'unknown') return true
            return gender === 'female' ? v.Gender === 'Female' : v.Gender === 'Male'
          })
          const candidates = pool.length ? pool : candidateVoiceList
          const key = gender || 'any'
          const i = voiceCursor.get(key) || 0
          voiceCursor.set(key, i + 1)
          return candidates[i % candidates.length].Name
        }
        // 单章普查结果增量合并进"最新"的角色表：先重读书状态，
        // 保证用户在规划期间手动修改/删除的行不被覆盖
        const applyStats = async (stats: CharacterStat[]): Promise<number> => {
          const fresh = await loadBook(id)
          if (!fresh) return 0
          const list = fresh.characterVoices || []
          // 旁白固定使用用户基准音色，始终存在
          if (!list.some((c) => c.character === '旁白')) {
            list.push({ character: '旁白', voice: narratorBase, dialog: 0 })
          }
          for (const s of stats) {
            if (s.name === '旁白') continue
            // 防御：brief 若就是人名（或互为包含）则不作为描述
            const briefOk =
              !!s.brief && !s.name.includes(s.brief) && !s.brief.includes(s.name)
            let entry = list.find(
              (c) =>
                c.character === s.name ||
                (c.character.length >= 2 &&
                  s.name.length >= 2 &&
                  (c.character.includes(s.name) || s.name.includes(c.character)))
            )
            if (!entry) {
              const gender = s.gender === 'unknown' ? undefined : s.gender
              entry = {
                character: s.name,
                voice: pickVoice(gender),
                gender,
                description: briefOk ? s.brief : undefined,
                dialog: 0,
                aliases: [],
              }
              list.push(entry)
              logger.info(`New character discovered: ${s.name} -> ${entry.voice}`)
            } else {
              // 同一角色的不同称呼：并入已有条目；更长的名字视为更正式，升级为正名
              if (s.name !== entry.character) {
                entry.aliases = [...new Set([...(entry.aliases || []), s.name])]
                if (s.name.length > entry.character.length) {
                  const old = entry.character
                  entry.character = s.name
                  entry.aliases = [...new Set([...(entry.aliases || []), old])]
                  logger.info(`Canonical name upgraded: ${old} -> ${s.name}`)
                }
              }
              // 本章实际使用的称呼也计入别名（如正名"凤姐"、本章称"王熙凤"）
              if (s.mentioned && s.mentioned !== entry.character) {
                entry.aliases = [...new Set([...(entry.aliases || []), s.mentioned])]
              }
              if (!entry.description && briefOk && s.brief) {
                entry.description = s.brief
              }
            }
            entry.dialog = (entry.dialog || 0) + s.dialog
          }
          // 按对白数加权排序：戏份多的角色排前面
          list.sort((a, b) => (b.dialog || 0) - (a.dialog || 0))
          fresh.characterVoices = list
          await saveBook(fresh)
          return list.length
        }
        // 旁白固定使用用户基准音色，始终存在
        await applyStats([])
        let discovered = 0
        let lastLabel = ''
        const stats = await surveyBookCharacters({
          texts: chapterTexts,
          lang,
          onProgress: (label) => {
            lastLabel = label
            void setDetail(`${label} · 已收录 ${discovered} 个角色`)
          },
          onStats: async (chapterStats) => {
            const count = await applyStats(chapterStats)
            discovered = count
            await setDetail(`${lastLabel} · 已收录 ${count} 个角色`)
          },
          getRosterNames: async () =>
            (await loadBook(id))?.characterVoices?.map((c) => c.character) || [],
          shouldStop: () => planningCanceled.has(id),
        })
        void stats
        // 用户停止：保留已收录的角色（含已预分配的音色），恢复为可重新规划状态
        if (planningCanceled.has(id)) {
          await update((b) => {
            b.message = '规划已手动停止，已收录的角色已保留，可继续编辑音色或重新规划'
          })
          return
        }
        // 通读完成：为全部角色生成性格描述（一次调用；失败回落使用普查身份提示）
        await update((b) => {
          b.planningDetail = '正在生成角色性格描述…'
        })
        try {
          const current = await loadBook(id)
          const rows = current?.characterVoices || []
          if (rows.length) {
            const enriched = await describeCharacters({
              lang,
              characters: rows.map((c) => ({
                name: c.character,
                dialog: c.dialog,
                brief: c.description?.slice(0, 12),
                aliases: c.aliases,
              })),
              onProgress: (label) => setDetail(label),
            })
            await update((b) => {
              for (const row of b.characterVoices || []) {
                let d = enriched.get(row.character)
                if (!d) {
                  // 双向包含匹配：LLM 返回的名字可能是变体（如"贾宝玉"vs 行名"宝玉"）
                  for (const [k, v] of enriched) {
                    if (
                      k.length >= 2 &&
                      row.character.length >= 2 &&
                      (k.includes(row.character) || row.character.includes(k))
                    ) {
                      d = v
                      break
                    }
                  }
                }
                // 仅覆盖"普查提示"级别的短描述（≤12 字）；用户手动写的详细描述保持不变
                if (d && (!row.description || row.description.length <= 12)) {
                  row.description = d
                }
              }
            })
          }
        } catch (e) {
          logger.warn(`Character description enrichment skipped: ${(e as Error).message}`)
        }
        // ===== 音色分配（两种可配置模式）=====
        if (assignMode === 'generate') {
          // 模式 B：AI 为每个角色生成专属音色——按对白数轮转分配 zh-CN 基础音色
          // （主要角色声线不重复），LLM 再按性格微调语速/音调/音量，以角色命名生成预设
          await setDetail('正在为各角色生成专属音色…')
          const genBook = await loadBook(id)
          const genRows = (genBook?.characterVoices || []).filter((r) => r.character !== '旁白')
          const zhBases = voiceList.filter((v) => v.Name.startsWith('zh-CN'))
          const femaleBases = zhBases.filter((v) => v.Gender === 'Female')
          const maleBases = zhBases.filter((v) => v.Gender === 'Male')
          const sorted = [...genRows].sort((a, b) => (b.dialog || 0) - (a.dialog || 0))
          const cursor = { Female: 0, Male: 0 }
          const baseOf = new Map<string, string>()
          for (const row of sorted) {
            const isMale = row.gender !== 'female'
            const pool = isMale ? maleBases : femaleBases
            if (!pool.length) continue
            const key = isMale ? 'Male' : 'Female'
            const base = pool[cursor[key] % pool.length]
            cursor[key]++
            baseOf.set(row.character, base.Name)
            logger.info(`Voice generate: ${row.character} -> base ${base.Name}`)
          }
          // LLM 按性格微调参数（快速模式；失败则使用默认参数，仍有基础音色轮转保证区分度）
          const paramMap = new Map<string, { rate?: string; pitch?: string; volume?: string }>()
          try {
            const paramRows = sorted.filter((r) => baseOf.has(r.character))
            const paramTable = paramRows
              .map(
                (r) =>
                  `${r.character}（基础音色 ${baseOf.get(r.character)!.replace('zh-CN-', '')}，${r.gender === 'male' ? '男' : '女'}，对白${r.dialog || 0} 句）：${r.description || '身份未知'}`
              )
              .join('\n')
            const prompt = `以下是一部小说的角色列表，每个角色已分配了基础音色。请根据角色性格，为每个角色微调语音参数使其更有辨识度。要求：
1. rate 语速范围 -15%~+15%，pitch 音调范围 -10Hz~+10Hz，volume 音量范围 -12%~+12%；
2. 参数要贴合角色性格（如 急躁角色语速偏快、沉稳角色语速偏慢、威严角色音调略低）；
3. 使用相同基础音色的角色之间参数要明显错开；
4. 逐个角色都要返回，不要遗漏。只输出 JSON：{"assignments":[{"character":"角色名","rate":"+5%","pitch":"-4Hz","volume":"+6%"}]}

### 角色与基础音色
${paramTable}`
            const resp = await safeRunWithRetry(
              async () => {
                return await openai.createChatCompletion({
                  messages: [
                    { role: 'system', content: 'You are a helpful assistant. And you can return valid json object' },
                    { role: 'user', content: prompt },
                  ],
                  temperature: 0.3,
                  max_tokens: 2000,
                  ...openai.fastExtractFields(openai.getModel()),
                  response_format: { type: 'json_object' },
                })
              },
              { retries: 2, baseDelayMs: 3000 }
            )
            const content = resp.choices[0]?.message?.content
            if (!content) throw new Error('LLM returned empty content')
            const parsed = parseJsonLoose(content)
            const arr = extractSegmentArray(parsed)
            for (const item of arr || []) {
              const character = typeof item.character === 'string' ? item.character.trim() : ''
              const rate = typeof item.rate === 'string' ? item.rate : ''
              const pitch = typeof item.pitch === 'string' ? item.pitch : ''
              const volume = typeof item.volume === 'string' ? item.volume : ''
              if (character) paramMap.set(character, { rate, pitch, volume })
            }
          } catch (e) {
            logger.warn(`Voice param generation failed, using defaults: ${(e as Error).message}`)
          }
          // 以角色命名生成专属预设并分配（重规划同名覆盖、ID 不变）
          for (const row of sorted) {
            const base = baseOf.get(row.character)
            if (!base) continue
            const p = paramMap.get(row.character) || {}
            const preset = await saveVoicePreset({
              name: row.character,
              voice: base,
              rate: p.rate,
              pitch: p.pitch,
              volume: p.volume,
              gender: row.gender,
            })
            await update((b) => {
              for (const r2 of b.characterVoices || []) {
                if (r2.character === row.character) r2.voice = preset.id
              }
            })
          }
          logger.info(`Generated exclusive voices for book ${id}: ${sorted.length} characters`)
        } else {
        // 按性格分配音色：LLM 依据角色性别+性格描述，从预设库中挑选最贴合的声线。
        // 性别不一致的分配会被跳过（保留原音色）
        await setDetail('正在按角色性格分配音色…')
        try {
          const matchBook = await loadBook(id)
          const matchRows = matchBook?.characterVoices || []
          const presetsAll = (await listVoicePresets()).filter((p) => !p.excludeFromAI)
          if (matchRows.length && presetsAll.length) {
            const genderOfPreset = new Map(presetsAll.map((p) => [p.id, p.gender || ''] as const))
            const assignments = await assignVoicesByPersonality({
              lang,
              characters: matchRows.map((c) => ({
                character: c.character,
                gender: c.gender,
                description: c.description,
                dialog: c.dialog,
              })),
              presets: presetsAll.map((p) => ({ id: p.id, name: p.name, gender: p.gender })),
            })
            let applied = 0
            await update((b) => {
              for (const row of b.characterVoices || []) {
                const voice = assignments.get(row.character)
                if (!voice) continue
                // 性别一致性兜底：预设性别与角色性别冲突时不采用
                const pg = genderOfPreset.get(voice) || ''
                if (row.gender && pg && row.gender !== pg) continue
                row.voice = voice
                applied++
              }
            })
            logger.info(
              `Personality-based voice assignment applied for book ${id}: ${applied}/${matchRows.length}`
            )
          }
        } catch (e) {
          logger.warn(`Personality voice assignment skipped: ${(e as Error).message}`)
        }
        }
        await update((b) => {
          b.planningDetail = `全书通读完成，共收录 ${discovered} 个角色音色（可在角色表中继续调整）`
        })
        logger.info(
          `Character voices planned for book ${id}: ${(await loadBook(id))?.characterVoices
            ?.map((c) => c.character)
            .join(', ')}`
        )
      } catch (err) {
        logger.error(`Character planning failed for book ${id}: ${(err as Error).message}`)
        await update((b) => {
          b.message = `角色音色规划失败：${(err as Error).message}`
        })
      } finally {
        await update((b) => {
          b.planning = false
          b.planningDetail = undefined
          b.planningStartedAt = undefined
        })
        planningCanceled.delete(id)
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
