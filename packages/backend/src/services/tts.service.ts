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
  characterVoices?: CharacterVoice[]
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
    result = await generateWithLLM(segment, voiceList, lang, task, onProgress, characterVoices)
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
  characterVoices?: CharacterVoice[]
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
    const result = await buildSegmentList(segment, llmSegments, task, onProgress)
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
        llmSegments
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
  onProgress?: TtsProgressCallback
): Promise<TTSResult> {
  const fileList: string[] = []
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
  const tasks = segments.map((segment, index) => async () => {
    const { text, pitch, voice, rate, volume } = segment
    const output = path.resolve(tmpDirPath, `${index + 1}_splits.mp3`)
    const cacheKey = taskManager.generateTaskId({ text, pitch, voice, rate, volume })
    const cache = await audioCacheInstance.getAudio(cacheKey)
    if (cache && (await isCacheEntryUsable(cache))) {
      logger.info(`Cache hit[segments]: ${voice} ${text.slice(0, 10)}`)
      fileList.push(cache.audio)
      handledLength++
      onProgress?.(handledLength, length)
      return cache
    }
    const result = await generateSingleVoice({ text, pitch, voice, rate, volume, output })
    logger.debug(`Cache miss and generate audio: ${result.audio}, ${result.srt}`)
    fileList.push(result.audio)
    handledLength++
    task?.updateProgress?.(task.id, getProgress())
    onProgress?.(handledLength, length)
    const params = { text, pitch, voice, rate, volume }
    await audioCacheInstance.setAudio(cacheKey, { ...params, ...result })
    return result
  })
  let partial = false
  const results = await runConcurrentTasks(tasks, EDGE_API_LIMIT)
  if (results?.some((result) => !result.success)) {
    logger.warn(`Partial result detected, some splits generated audio failed!`, results)
    partial = true
  }
  const outputFile = path.resolve(AUDIO_DIR, id)
  logger.debug(`Concatenating audio files from ${tmpDirPath} to ${outputFile}`)
  await concatDirAudio({ inputDir: tmpDirPath, fileList, outputFile })
  await concatDirSrt({ inputDir: tmpDirPath, fileList, outputFile })
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
 * 拼接音频文件
 */
export async function concatDirAudio({
  fileList,
  outputFile,
  inputDir,
}: ConcatAudioParams): Promise<void> {
  const mp3Files = sortAudioDir(fileList, '.mp3')
  if (!mp3Files.length) throw new Error('No MP3 files found in input directory')

  const tempListPath = path.resolve(inputDir, 'file_list.txt')
  await fs.writeFile(tempListPath, mp3Files.map((file) => `file '${file}'`).join('\n'))

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
 * 拼接字幕文件
 */
export async function concatDirSrt({
  fileList,
  outputFile,
  inputDir,
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
  const mergedJson = mergeSubtitleFiles(subtitleFiles)
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
}
