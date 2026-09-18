import path, { resolve } from 'path'
import { Response } from 'express'
import fs, { readdir } from 'fs/promises'
import ffmpeg from '../utils/ffmpeg'
import { AUDIO_DIR, STATIC_DOMAIN, EDGE_API_LIMIT } from '../config'
import { logger } from '../utils/logger'
import { fetchLlmSegments, NormalizedSegment } from '../llm/segmentParser'
import {
  asyncSleep,
  ensureDir,
  generateId,
  getLangConfig,
  readJson,
  safeRunWithRetry,
  streamToResponse,
} from '../utils'
import { splitText } from './text.service'
import { generateSingleVoiceStream, generateSrt } from './edge-tts.service'
import { EdgeSchema } from '../schema/generate'
import { MapLimitController } from '../controllers/concurrency.controller'
import audioCacheInstance, { isCacheEntryUsable } from './audioCache.service'
import { mergeSubtitleFiles, SubtitleFile, SubtitleFiles } from '../utils/subtitle'
import taskManager, { Task } from '../utils/taskManager'
import { Readable, PassThrough } from 'stream'
import { createWriteStream } from 'fs'

// 错误消息枚举
enum ErrorMessages {
  ENG_MODEL_INVALID_TEXT = 'English model cannot process non-English text',
  API_FETCH_FAILED = 'Failed to fetch TTS parameters from API',
  INVALID_API_RESPONSE = 'Invalid API response: no TTS parameters returned',
  PARAMS_PARSE_FAILED = 'Failed to parse TTS parameters',
  INVALID_PARAMS_FORMAT = 'Invalid TTS parameters format',
  TTS_GENERATION_FAILED = 'TTS generation failed',
  INCOMPLETE_RESULT = 'Incomplete TTS result',
}

/**
 * 流式生成文本转语音 (TTS) 的音频和字幕
 */
export async function generateTTSStream(params: Required<EdgeSchema>, task: Task) {
  const { text, pitch, voice, rate, volume, useLLM } = params
  const segment: Segment = { id: generateId(useLLM ? 'aigen-' : voice, text), text }
  const { lang, voiceList } = await getLangConfig(segment.text)
  logger.debug(`Language detected lang: `, lang)
  task!.context!.segment = segment
  task!.context!.lang = lang
  task!.context!.voiceList = voiceList
  const { res } = task.context as Required<NonNullable<Task['context']>>
  if (!validateLangAndVoice(lang, voice, res)) {
    task?.endTask?.(task.id)
    return
  }

  // 检查缓存, 如果有缓存则直接返回（且缓存文件真实存在）
  const cacheKey = taskManager.generateTaskId({ text, pitch, voice, rate, volume })
  const cache = await audioCacheInstance.getAudio(cacheKey)
  if (cache && (await isCacheEntryUsable(cache))) {
    const data = {
      ...cache,
      file: path.parse(cache.audio).base,
      srt: path.parse(cache.srt).base,
      text: '',
    }
    logger.info(`Cache hit: ${voice} ${text.slice(0, 10)}`)
    task.context?.res?.setHeader('x-generate-tts-type', 'application/json')
    task.context?.res?.setHeader('Access-Control-Expose-Headers', 'x-generate-tts-type')
    task.context?.res?.json({ code: 200, data, success: true })
    task.endTask?.(task.id)
    return
  }

  if (useLLM) {
    generateWithLLMStream(task).catch((err) => failStreamTask(task, err as Error))
  } else {
    generateWithoutLLMStream({ ...params, output: segment.id }, task).catch((err) =>
      failStreamTask(task, err as Error)
    )
  }
}
export async function generateTTSStreamJson(formatedBody: Required<EdgeSchema>[], task: Task) {
  const { segment } = task.context as Required<NonNullable<Task['context']>>
  const output = path.resolve(AUDIO_DIR, segment.id)
  const segments = formatedBody
  logger.info(`generateTTSStreamJson splitText length: ${formatedBody.length} `)
  const buildSegments = segments.map((segment) => ({ ...segment, output }))
  logger.info('buildSegments:', buildSegments)
  buildSegmentList(buildSegments, task).catch((err) => failStreamTask(task, err as Error))
}

/**
 * 标记流式任务失败并中断响应：客户端 reader.read() 会 reject 走 onError，
 * 绝不会把已生成的部分音频当成功收尾
 */
export function failStreamTask(task: Task, err: Error) {
  logger.error(`Stream task ${task.id} failed: ${err.message}`)
  if (taskManager.getTask(task.id)?.status === 'pending') {
    taskManager.failTask(task.id, { message: err.message })
  }
  const res = (task.context as { res?: Response } | undefined)?.res
  if (!res || res.writableEnded || res.destroyed) return
  if (!res.headersSent) {
    // 尚未发出任何音频字节：返回规范的 500 JSON，前端走通用错误处理
    res.status(500).json({ code: 500, success: false, message: err.message })
  } else {
    // 已在传输中：只能断开连接，让客户端 read() reject 走 onError，绝不伪装成功
    res.destroy(err)
  }
}

/**
 * 等待音频流结束。必须监听 error，且带看门狗：
 * Edge 长连接可能中途挂起（既不 end 也不 error），超时后主动销毁并按失败处理，
 * 否则整个生成会永远停在半截。
 */
function waitForStreamEnd(stream: Readable, timeoutMs = 90_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy()
      reject(new Error(`Audio stream did not finish within ${timeoutMs}ms`))
    }, timeoutMs)
    stream.once('end', () => {
      clearTimeout(timer)
      resolve()
    })
    stream.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

function generateEdgeStreamWithRetry(
  segment: NormalizedSegment,
  output: string,
  maxRetries = 3
): Promise<Readable> {
  return safeRunWithRetry(
    () =>
      generateSingleVoiceStream({
        ...segment,
        output,
        outputType: 'stream',
      }) as Promise<Readable>,
    {
      retries: maxRetries,
      baseDelayMs: 1000,
      onError: (err: unknown, attempt) =>
        logger.warn(`Edge stream attempt ${attempt} failed: ${(err as Error).message}`),
    }
  )
}

/**
 * 使用 LLM 生成 TTS
 */
async function generateWithLLMStream(task: Task) {
  const { segment, voiceList, lang, res } = task.context as Required<NonNullable<Task['context']>>
  const { text, id } = segment
  const { length, segments: textSegments } = splitText(text.trim())
  if (length <= 1) {
    const llmSegments = await fetchLlmSegments({ lang, voiceList, text: textSegments[0] })
    await buildSegmentList(llmSegments, task)
  } else {
    const output = resolve(AUDIO_DIR, id)
    let count = 0
    logger.info('Splitting text into multiple segments:', textSegments.length)
    const getProgress = () => {
      return Number(((count / textSegments.length) * 100).toFixed(2))
    }
    const localStream = createWriteStream(output)
    const outputStream = new PassThrough()
    outputStream.pipe(res)
    outputStream.pipe(localStream)
    let clientGone = false
    // 落盘流必须挂 error 监听：任何 fs/写入错误若无人处理会以 unhandled 'error' 击垮进程
    localStream.on('error', (err) => {
      logger.error(`Local write stream error for task ${task.id}: ${err.message}`)
      clientGone = true
      outputStream.destroy()
    })
    res.on('close', () => {
      if (res.writableEnded) return // 响应正常结束后的 close 不是客户端断开
      clientGone = true
      outputStream.destroy()
      localStream.destroy()
      // 客户端已离开，任务必须收尾，否则 pending 任务泄漏会占满 taskManager 上限
      task.endTask?.(task.id)
    })

    try {
      for (const seg of textSegments) {
        if (clientGone) {
          logger.warn(`Client disconnected, abort LLM stream for task ${task.id}`)
          return
        }
        count++
        const llmSegments = await fetchLlmSegments({ lang, voiceList, text: seg })
        for (const segment of llmSegments) {
          if (clientGone) {
            task.endTask?.(task.id)
            return
          }
          const audioStream = await generateEdgeStreamWithRetry(segment, output)
          audioStream.pipe(outputStream, { end: false })
          await waitForStreamEnd(audioStream)
        }
        logger.info(`Progress: ${getProgress()}%`)
      }
      outputStream.end()
      task.endTask?.(task.id)
      setTimeout(() => {
        handleSrt(output)
      }, 200)
    } catch (err) {
      logger.error(`LLM stream generation failed for task ${task.id}: ${(err as Error).message}`)
      outputStream.destroy()
      localStream.destroy()
      failStreamTask(task, err as Error)
    }
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
  return {
    audio: `${STATIC_DOMAIN}/${id}`,
    srt: `${STATIC_DOMAIN}/${id.replace('.mp3', '.srt')}`,
  }
}

async function generateWithoutLLMStream(params: TTSParams, task: Task) {
  const { segment } = task.context as Required<NonNullable<Task['context']>>
  const { text } = segment
  const { length, segments } = splitText(text)
  logger.info(`splitText length: ${length} `)
  if (length <= 1) {
    buildSegment(params, task)
  } else {
    const buildSegments = segments.map((segment) => ({ ...params, text: segment }))
    buildSegmentList(buildSegments, task)
  }
}

/**
 * 生成单个片段的音频和字幕
 */
async function buildSegment(params: TTSParams, task: Task, dir: string = '') {
  const { segment } = task.context as Required<NonNullable<Task['context']>>
  const output = path.resolve(AUDIO_DIR, dir, segment.id)
  const stream = (await generateSingleVoiceStream({
    ...params,
    output,
    outputType: 'stream',
  })) as Readable
  const { res } = task.context as Required<NonNullable<Task['context']>>

  streamToResponse(res, stream, {
    headers: {
      'content-type': 'application/octet-stream',
      'x-generate-tts-type': 'stream',
      'Access-Control-Expose-Headers-generate-tts-id': task.id,
    },
    fileName: segment.id,
    onError: (err) => `Custom error: ${err.message}`,
    onEnd: () => {
      task?.endTask?.(task.id)
      logger.info(`Streaming ${task.id} finished`)
      setTimeout(() => {
        handleSrt(output)
      }, 200)
    },
  })
}

/**
 * 生成多个片段并合并的 TTS
 */

interface SegmentError extends Error {
  segmentIndex: number
  attempt: number
}
export async function handleSrt(audioPath: string, stream = true) {
  if (!stream) {
    const tempJsonPath = audioPath + '.json'
    await generateSrt(tempJsonPath, audioPath.replace('.mp3', '.srt'))
    return
  }
  const { dir, base } = path.parse(audioPath)
  const tmpDir = audioPath + '_tmp'
  await ensureDir(tmpDir)

  const fileList = (await readdir(tmpDir))
    .filter((file) => file.includes(base) && file.includes('.json'))
    .sort((a, b) => Number(a.split('.json.')?.[1] || 0) - Number(b.split('.json.')?.[1] || 0))
    .map((file) => path.join(tmpDir, file))
  if (!fileList.length) return
  concatDirSrt({ jsonFiles: fileList, inputDir: tmpDir, outputFile: audioPath })
}
async function buildSegmentList(segments: NormalizedSegment[], task: Task): Promise<void> {
  const { res, segment } = task.context as Required<NonNullable<Task['context']>>
  const { id: outputId } = segment
  const totalSegments = segments.length
  const output = path.resolve(AUDIO_DIR, outputId)
  let completedSegments = 0
  if (!totalSegments) {
    task?.endTask?.(task.id)
    return void res.status(400).end('No segments provided')
  }

  const progress = () => Number(((completedSegments / totalSegments) * 100).toFixed(2))
  const outputStream = new PassThrough()

  streamToResponse(res, outputStream, {
    headers: {
      'content-type': 'application/octet-stream',
      'x-generate-tts-type': 'stream',
      'Access-Control-Expose-Headers-generate-tts-id': task.id,
    },
    onError: (err) => `Custom error: ${err.message}`,
    fileName: segment.id,
    onEnd: () => {
      task?.endTask?.(task.id)
      logger.info(`Streaming ${task.id} finished`)
      setTimeout(() => {
        handleSrt(output)
      }, 200)
    },
    onClose: () => {
      task?.endTask?.(task.id)
      logger.info(`Streaming ${task.id} closed`)
    },
  })

  const processSegment = async (index: number, maxRetries = 3): Promise<void> => {
    if (index >= totalSegments) {
      outputStream.end()
      task?.endTask?.(task.id)
      return
    }

    const segment = segments[index]
    const generateWithRetry = async (attempt = 0): Promise<Readable> => {
      try {
        return (await generateSingleVoiceStream({
          ...segment,
          outputType: 'stream',
          output,
        })) as Readable
      } catch (err) {
        const error = err as Error
        if (attempt + 1 >= maxRetries) {
          throw Object.assign(error, { segmentIndex: index, attempt: attempt + 1 } as SegmentError)
        }
        logger.warn(
          `Segment ${index + 1} failed (attempt ${attempt + 1}/${maxRetries}): ${error.message}`
        )
        await asyncSleep(1000)
        return generateWithRetry(attempt + 1)
      }
    }

    try {
      // TODO: Concurrency of streaming flow
      const audioStream = await generateWithRetry()
      await audioStream.pipe(outputStream, { end: false })
      await waitForStreamEnd(audioStream)
      completedSegments++
      logger.info(`processing text:\n ${segment.text.slice(0, 10)}...`)
      logger.info(`Segment ${index + 1}/${totalSegments} completed. Progress: ${progress()}%`)
      await processSegment(index + 1)
    } catch (err) {
      // 错误可能来自消费阶段（waitForStreamEnd）而非生成阶段，字段可能缺失
      const { segmentIndex = index, attempt = maxRetries, message } = err as SegmentError
      logger.error(`Segment ${segmentIndex + 1} failed after ${attempt} retries: ${message}`)
      outputStream.emit('error', err)
    }
  }

  try {
    await processSegment(0)
  } catch (err) {
    logger.error(`Audio processing aborted: ${(err as Error).message}`)
    !res.headersSent && res.status(500).end('Internal server error')
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
function validateLangAndVoice(lang: string, voice: string, res: Response): boolean {
  if (lang !== 'eng' && voice.startsWith('en')) {
    res.status(400).send({
      code: 400,
      success: false,
      message: ErrorMessages.ENG_MODEL_INVALID_TEXT,
    })
    return false
  }
  return true
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
  const mp3Files = sortAudioDir(fileList!, '.mp3')
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
  jsonFiles,
}: ConcatAudioParams): Promise<void> {
  const _jsonFiles =
    jsonFiles ||
    sortAudioDir(
      fileList!.map((file) => `${file}.json`),
      '.json'
    )
  if (!_jsonFiles.length) throw new Error('No JSON files found for subtitles')

  const subtitleFiles = (
    await Promise.all(_jsonFiles.map((file) => readJson<SubtitleFile>(file)))
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
  fileList?: string[]
  outputFile: string
  inputDir: string
  jsonFiles?: string[]
}
