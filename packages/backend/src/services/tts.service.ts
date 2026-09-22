import path from 'path'
import fs from 'fs/promises'
import ffmpeg from '../utils/ffmpeg'
import { AUDIO_DIR, STATIC_DOMAIN, EDGE_API_LIMIT } from '../config'
import { logger } from '../utils/logger'
import { fetchLlmSegments, NormalizedSegment, CharacterVoice } from '../llm/segmentParser'
import { ensureDir, generateId, getLangConfig, readJson } from '../utils'
import { splitText } from './text.service'
import { generateSingleVoice, generateSrt } from './edge-tts.service'
import { EdgeSchema } from '../schema/generate'
import { MapLimitController } from '../controllers/concurrency.controller'
import audioCacheInstance, { isCacheEntryUsable } from './audioCache.service'
import { mergeSubtitleFiles, SubtitleFile, SubtitleFiles } from '../utils/subtitle'
import taskManager, { Task } from '../utils/taskManager'
import { handleSrt } from './tts.stream.service'
import { convertAudioFile, isVcEngine } from './vc.service'

// 错误消息枚举
export enum ErrorMessages {
  ENG_MODEL_INVALID_TEXT = 'English model cannot process non-English text',
  API_FETCH_FAILED = 'Failed to fetch TTS parameters from API',
  INVALID_API_RESPONSE = 'Invalid API response: no TTS parameters returned',
  PARAMS_PARSE_FAILED = 'Failed to parse TTS parameters',
  INVALID_PARAMS_FORMAT = 'Invalid TTS parameters format',
  TTS_GENERATION_FAILED = 'TTS generation failed',
  INCOMPLETE_RESULT = 'Incomplete TTS result',
}

/**
 * 生成文本转语音 (TTS) 的音频和字幕
 */
export type TtsProgressCallback = (done: number, total: number) => void

export async function generateTTS(
  params: Required<EdgeSchema>,
  task?: Task,
  onProgress?: TtsProgressCallback,
  characterVoices?: CharacterVoice[],
  /** 音色转换引擎：openvoice/rvc 时，角色绑定的换声源（vcRef）生效 */
  voiceEngine?: string
): Promise<TTSResult> {
  const { text, pitch, voice, rate, volume, useLLM } = params
  // 检查缓存
  const cacheKey = taskManager.generateTaskId({ text, pitch, voice, rate, volume })
  const cache = await audioCacheInstance.getAudio(cacheKey)
  if (cache && (await isCacheEntryUsable(cache))) {
    logger.info(`Cache hit: ${voice} ${text.slice(0, 10)}`)
    return cache
  }

  const segment: Segment = { id: generateId(`${useLLM ? 'aigen-' : voice}`, text), text }
  const { lang, voiceList } = await getLangConfig(segment.text)
  logger.debug(`Language detected lang: `, lang)
  validateLangAndVoice(lang, voice)

  let result: TTSResult
  if (useLLM) {
    result = await generateWithLLM(segment, voiceList, lang, task, onProgress, characterVoices, voiceEngine)
  } else {
    result = await generateWithoutLLM(segment, { text, pitch, voice, rate, volume, output: segment.id }, task, onProgress)
  }

  // 验证结果并缓存
  validateTTSResult(result, segment.id)
  logger.info(`Generated audio succeed: `, result)
  if (result.partial) {
    logger.warn(`Partial result detected, some splits generated audio failed!`)
  } else {
    await audioCacheInstance.setAudio(cacheKey, { ...params, ...result })
  }
  return result
}

/**
 * 使用 LLM 生成 TTS
 */
async function generateWithLLM(
  segment: Segment,
  voiceList: VoiceConfig[],
  lang: string,
  task?: Task,
  onProgress?: TtsProgressCallback,
  characterVoices?: CharacterVoice[],
  voiceEngine?: string
): Promise<TTSResult> {
  const { text, id } = segment
  const { length, segments: textSegments } = splitText(text.trim())
  if (length <= 1) {
    const llmSegments = await fetchLlmSegments({
      lang,
      voiceList,
      text: textSegments[0],
      characterVoices,
    })
    const result = await buildSegmentList(segment, llmSegments, task, onProgress, voiceEngine)
    task?.updateProgress?.(task.id, 100)
    return result
  } else {
    logger.info('Splitting text into multiple segments:', textSegments.length)
    let finalSegments = []
    let count = 0
    const getProgress = () => {
      return Number(((count / textSegments.length) * 100).toFixed(2))
    }
    for (let seg of textSegments) {
      count++
      const llmSegments = await fetchLlmSegments({ lang, voiceList, text: seg, characterVoices })
      const result = await buildSegmentList(
        // 前缀不能含冒号：该 id 会用作 Windows 临时目录名（冒号为保留字符）
        { ...segment, id: `segments-${count}-${segment.id}` },
        llmSegments,
        task,
        onProgress,
        voiceEngine
      )
      task?.updateProgress?.(task.id, getProgress())
      finalSegments.push(result)
      onProgress?.(count, textSegments.length)
    }
    return await buildFinal(finalSegments, id)
  }
}
const buildFinal = async (finalSegments: TTSResult[], id: string) => {
  const subtitleFiles: SubtitleFiles = await Promise.all(
    finalSegments.map((file) => {
      const base = path.basename(file.audio)
      const jsonPath = path.resolve(AUDIO_DIR, base.replace('.mp3', ''), 'all_splits.mp3.json')
      return readJson<SubtitleFile>(jsonPath)
    })
  )

  const mergedJson = mergeSubtitleFiles(subtitleFiles)
  const finalDir = path.resolve(AUDIO_DIR, id.replace('.mp3', ''))
  await ensureDir(finalDir)
  const finalJson = path.resolve(finalDir, '[merged]all_splits.mp3.json')
  await fs.writeFile(finalJson, JSON.stringify(mergedJson, null, 2))
  await generateSrt(finalJson, path.resolve(AUDIO_DIR, id.replace('.mp3', '.srt')))
  const fileList = finalSegments.map((segment) =>
    path.resolve(AUDIO_DIR, path.parse(segment.audio).base)
  )
  const outputFile = path.resolve(AUDIO_DIR, id)
  await concatDirAudio({ inputDir: finalDir, fileList, outputFile })
  // 拼接完成后，各分段的中间产物（mp3/srt/字幕json/临时目录）已无用，统一清理保持根目录整洁
  await Promise.all(
    finalSegments.map(async (segment) => {
      const base = decodeURIComponent(segment.audio.split('/').pop() || '')
      const stem = base.replace(/\.mp3$/, '')
      await fs.rm(path.resolve(AUDIO_DIR, base), { force: true })
      await fs.rm(path.resolve(AUDIO_DIR, `${base}.json`), { force: true })
      await fs.rm(path.resolve(AUDIO_DIR, `${stem}.srt`), { force: true })
      await fs.rm(path.resolve(AUDIO_DIR, stem), { recursive: true, force: true })
    })
  )
  return {
    audio: `${STATIC_DOMAIN}/${id}`,
    srt: `${STATIC_DOMAIN}/${id.replace('.mp3', '.srt')}`,
    // 关键：多分段合并时必须聚合各分段的 partial 标记。
    // 丢失它会让"缺片段"的长章节被标记为已完成，成品电子书静默缺失内容
    partial: finalSegments.some((segment) => segment.partial),
  }
}
/**
 * 不使用 LLM 生成 TTS
 */
async function generateWithoutLLM(
  segment: Segment,
  params: TTSParams,
  task?: Task,
  onProgress?: TtsProgressCallback
): Promise<TTSResult> {
  const { text, pitch, voice, rate, volume } = params
  const { length, segments } = splitText(text)

  if (length <= 1) {
    const result = await buildSegment(segment, params)
    onProgress?.(1, 1)
    return result
  } else {
    const buildSegments = segments.map((segment) => ({ ...params, text: segment }))
    const result = await buildSegmentList(segment, buildSegments, task, onProgress)
    task?.updateProgress?.(task.id, 100)
    return result
  }
}

/**
 * 生成单个片段的音频和字幕
 */
async function buildSegment(
  segment: Segment,
  params: TTSParams,
  dir: string = ''
): Promise<TTSResult> {
  const { id, text } = segment
  const { pitch, voice, rate, volume } = params
  const output = path.resolve(AUDIO_DIR, dir, id)
  const result = await generateSingleVoice({
    text,
    pitch,
    voice,
    rate,
    volume,
    output,
  })
  logger.info('Generated single segment:', result)
  setTimeout(() => {
    handleSrt(output, false)
  }, 200)
  return {
    audio: `${STATIC_DOMAIN}/${path.join(dir, id)}`,
    srt: `${STATIC_DOMAIN}/${path.join(dir, id.replace('.mp3', '.srt'))}`,
  }
}

/**
 * 生成多个片段并合并的 TTS
 */
async function buildSegmentList(
  segment: Segment,
  segments: NormalizedSegment[],
  task?: Task,
  onProgress?: TtsProgressCallback,
  /** 音色转换引擎；角色绑定的换声源（vcRef）在该引擎下生效 */
  voiceEngine?: string
): Promise<TTSResult> {
  const length = segments.length
  let handledLength = 0

  if (!length) {
    throw new Error(`No segments found for task ${task?.id || 'unknown'}!`)
  }
  const { id } = segment
  const tmpDirName = id.replace('.mp3', '')
  const tmpDirPath = path.resolve(AUDIO_DIR, tmpDirName)
  await ensureDir(tmpDirPath)
  await fs.writeFile(
    path.resolve(tmpDirPath, 'ai-segments.json'),
    JSON.stringify(segments, null, 2)
  )
  const getProgress = () => {
    return Number((((handledLength / length) * 100) / (id.includes('segment') ? 2 : 1)).toFixed(2))
  }
  // 失败片段多轮自动补齐：Edge 偶发断流（1006 等）多为瞬时故障，逐轮退避重试，
  // 保证章节音频内容完整——绝不允许"缺段"的有声书；仍失败的章节标记 partial，
  // 由章节级重试兜底（已成功的片段走缓存，重试代价极小）。
  // 片段音频按索引收进 audioByIndex，最终统一组装：同一片段无论重跑几轮都只会出现一次，
  // 从结构上杜绝"重复播放同一句"。
  const MAX_ROUNDS = 4
  const audioByIndex = new Map<number, string>()
  const doneIndexes = new Set<number>()
  let pending = segments.map((segment, index) => ({ segment, index }))
  let round = 0
  while (pending.length && round < MAX_ROUNDS) {
    if (round > 0) {
      const backoffMs = 3000 * round
      logger.warn(
        `Retrying ${pending.length} failed segment(s) of ${id} (round ${round + 1}/${MAX_ROUNDS}) after ${backoffMs}ms`
      )
      await new Promise((resolve) => setTimeout(resolve, backoffMs))
    }
    const tasks = pending.map(({ segment, index }) => async () => {
      const { text, pitch, voice, rate, volume, vcRef } = segment
      const vcOptions = isVcEngine(voiceEngine) && vcRef ? { engine: voiceEngine, ref: vcRef } : undefined
      const output = path.resolve(tmpDirPath, `${index + 1}_splits.mp3`)
      const cacheKey = taskManager.generateTaskId({
        text,
        pitch,
        voice,
        rate,
        volume,
        vcEngine: vcOptions?.engine,
        vcRef: vcOptions?.ref,
      })
      const cache = await audioCacheInstance.getAudio(cacheKey)
      if (cache && (await isCacheEntryUsable(cache))) {
        logger.info(`Cache hit[segments]: ${voice} ${text.slice(0, 10)}`)
        audioByIndex.set(index, cache.audio)
        if (!doneIndexes.has(index)) {
          doneIndexes.add(index)
          onProgress?.(++handledLength, length)
        }
        return cache
      }
      const result = await generateSingleVoice({
        text,
        pitch,
        voice,
        rate,
        volume,
        output,
      })
      logger.debug(`Cache miss and generate audio: ${result.audio}, ${result.srt}`)
      // 音色转换：edge 合成的基础音频 → vc-server 频谱换声；失败时回落原声（不中断整章生成）
      let audioFile = result.audio
      if (vcOptions) {
        try {
          audioFile = await convertAudioFile(output, vcOptions)
        } catch (err) {
          logger.warn(`Voice conversion failed (${vcOptions.ref}), using base voice: ${(err as Error).message}`)
        }
      }
      audioByIndex.set(index, audioFile)
      if (!doneIndexes.has(index)) {
        doneIndexes.add(index)
        task?.updateProgress?.(task.id, getProgress())
        onProgress?.(++handledLength, length)
      }
      const params = { text, pitch, voice, rate, volume }
      await audioCacheInstance.setAudio(cacheKey, { ...params, ...result, audio: audioFile })
      return result
    })
    const results = await runConcurrentTasks(tasks, EDGE_API_LIMIT)
    // 从待补齐列表中移除本轮成功的片段（倒序 splice 保持索引对齐）
    for (let i = pending.length - 1; i >= 0; i--) {
      if (results?.[i]?.success) pending.splice(i, 1)
    }
    round++
  }
  // 按原始段序组装文件列表：缺失的片段（多轮重试后仍失败）不会出现在拼接中
  const fileList: string[] = []
  for (let i = 0; i < length; i++) {
    const audioFile = audioByIndex.get(i)
    if (audioFile) fileList.push(audioFile)
  }
  const partial = pending.length > 0
  if (partial) {
    logger.error(
      `Chapter ${id}: ${pending.length} segment(s) still failed after ${MAX_ROUNDS} rounds, chapter marked partial`
    )
  }
  // 段间停顿：Edge 免费端点不支持 SSML break，改为拼接时插入真实静音。
  // 说话人切换停顿更长（520ms），同一说话人较短（260ms），末段不加
  const segmentPausesMs = segments.map((segment, index) => {
    const next = segments[index + 1]
    if (!next) return 0
    return next.voice !== segment.voice ? 520 : 260
  })
  const outputFile = path.resolve(AUDIO_DIR, id)
  logger.debug(`Concatenating audio files from ${tmpDirPath} to ${outputFile}`)
  await concatDirAudio({ inputDir: tmpDirPath, fileList, outputFile, segmentPausesMs })
  await concatDirSrt({ inputDir: tmpDirPath, fileList, outputFile, segmentPausesMs })
  logger.debug(
    `Concatenating SRT files from ${tmpDirPath} to ${outputFile.replace('.mp3', '.srt')}`
  )

  return {
    audio: `${STATIC_DOMAIN}/${id}`,
    srt: `${STATIC_DOMAIN}/${id.replace('.mp3', '.srt')}`,
    partial,
  }
}

/**
 * 并发执行任务
 */
async function runConcurrentTasks(tasks: (() => Promise<any>)[], limit: number): Promise<any[]> {
  logger.debug(`Running ${tasks.length} tasks with a limit of ${limit}`)
  const controller = new MapLimitController(tasks, limit, () =>
    logger.info('All concurrent tasks completed')
  )
  const { results, cancelled } = await controller.run()
  logger.info(`Tasks completed: ${results.length}, cancelled: ${cancelled}`)
  logger.debug(`Task results:`, results)
  return results
}

/**
 * 验证语言和语音参数
 */
function validateLangAndVoice(lang: string, voice: string): void {
  if (lang !== 'eng' && voice.startsWith('en')) {
    throw new Error(ErrorMessages.ENG_MODEL_INVALID_TEXT)
  }
}

/**
 * 验证 TTS 结果
 */
function validateTTSResult(result: TTSResult, segmentId: string): void {
  if (!result.audio) {
    throw new Error(`${ErrorMessages.INCOMPLETE_RESULT} for segment ${segmentId}`)
  }
}

/**
 * 拼接音频文件（可选段间静音插入，用于对话/段落间的自然停顿）
 */
export async function concatDirAudio({
  fileList,
  outputFile,
  inputDir,
  segmentPausesMs,
}: ConcatAudioParams): Promise<void> {
  const mp3Files = sortAudioDir(fileList, '.mp3')
  if (!mp3Files.length) throw new Error('No MP3 files found in input directory')

  let listEntries = mp3Files.map((file) => `file '${file}'`)
  if (segmentPausesMs?.some((ms) => ms > 0)) {
    // Edge 免费端点不支持 SSML break：段间停顿用真实静音片段在拼接时插入。
    // 静音参数与 Edge 输出一致（24kHz 单声道 96kbps MP3），保证 concat copy 兼容
    const silFiles = new Map<number, string>()
    const entries: string[] = []
    for (let i = 0; i < mp3Files.length; i++) {
      entries.push(`file '${mp3Files[i]}'`)
      const ms = segmentPausesMs[i] || 0
      if (ms > 0 && i < mp3Files.length - 1) {
        let sil = silFiles.get(ms)
        if (!sil) {
          const silPath = path.resolve(inputDir, `pause_${ms}ms.mp3`)
          await new Promise<void>((resolve, reject) => {
            ffmpeg()
              .input('anullsrc=r=24000:cl=mono')
              .inputFormat('lavfi')
              .audioCodec('libmp3lame')
              .audioBitrate(96)
              .duration(ms / 1000)
              .output(silPath)
              .on('end', () => resolve())
              .on('error', (err) => reject(new Error(`Silence generation failed: ${err.message}`)))
              .run()
          })
          sil = silPath
          silFiles.set(ms, sil)
        }
        entries.push(`file '${sil}'`)
      }
    }
    listEntries = entries
  }

  const tempListPath = path.resolve(inputDir, 'file_list.txt')
  await fs.writeFile(tempListPath, listEntries.join('\n'))

  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(tempListPath)
      .inputFormat('concat')
      .inputOption('-safe', '0')
      .audioCodec('copy')
      .output(outputFile)
      .on('end', () => resolve())
      .on('error', (err) => reject(new Error(`Concat failed: ${err.message}`)))
      .run()
  })
}

/**
 * 拼接字幕文件（与音频静音插入同步：逐边界补偿段间停顿，保证字幕不漂移）
 */
export async function concatDirSrt({
  fileList,
  outputFile,
  inputDir,
  segmentPausesMs,
}: ConcatAudioParams): Promise<void> {
  const jsonFiles = sortAudioDir(
    fileList.map((file) => `${file}.json`),
    '.json'
  )
  if (!jsonFiles.length) throw new Error('No JSON files found for subtitles')

  const subtitleFiles = (
    await Promise.all(jsonFiles.map((file) => readJson<SubtitleFile>(file)))
  ).filter((subtitle): subtitle is SubtitleFile => Array.isArray(subtitle))
  // 克隆等非 Edge 音源没有字幕数据：跳过字幕合并，不视为失败
  if (!subtitleFiles.length) {
    logger.warn('No subtitle data found, skip srt merge')
    return
  }
  const mergedJson = mergeSubtitleFiles(subtitleFiles, 0, segmentPausesMs)
  const tempJsonPath = path.resolve(inputDir, 'all_splits.mp3.json')
  await fs.writeFile(tempJsonPath, JSON.stringify(mergedJson, null, 2))
  await generateSrt(tempJsonPath, outputFile.replace('.mp3', '.srt'))
}

/**
 * 按文件名排序音频文件
 */
function sortAudioDir(fileList: string[], ext: string = '.mp3'): string[] {
  return fileList
    .filter((file) => path.extname(file).toLowerCase() === ext)
    .sort(
      (a, b) => Number(path.parse(a).name.split('_')[0]) - Number(path.parse(b).name.split('_')[0])
    )
}

export interface ConcatAudioParams {
  fileList: string[]
  outputFile: string
  inputDir: string
  /** 段间停顿毫秒：pauses[i] 为第 i 段之后插入的静音时长（最后一段为 0）。提供时按显式顺序拼接 */
  segmentPausesMs?: number[]
}
