import fs from 'fs/promises'
import { EdgeSchema } from '../schema/generate'
import { EdgeTTS } from '../lib/node-edge-tts/edge-tts-fixed'
import { fileExist, readJson, safeRunWithRetry } from '../utils'
import { logger } from '../utils/logger'
import { isCustomVoice, synthesizeCloneVoice } from './clone-tts.service'

// 微软官方支持情感风格（mstts:express-as）的声音（按名称片段匹配）。
// 不支持的声音传入 style 会被忽略，保持原语气合成。
const STYLE_SUPPORTED_VOICE_PATTERNS = [
  'XiaoxiaoNeural',
  'XiaoyiNeural',
  'YunjianNeural',
  'YunxiNeural',
  'YunyangNeural',
  'YunyeNeural',
  'YunzeNeural',
]

function supportsStyle(voice: string): boolean {
  return STYLE_SUPPORTED_VOICE_PATTERNS.some((pattern) => voice.includes(pattern))
}

export async function runEdgeTTS({
  text,
  pitch,
  volume,
  voice,
  rate,
  output,
  outputType = 'file',
  style,
  styleDegree,
}: Omit<EdgeSchema, 'useLLM'> & {
  output: string
  outputType?: string
  style?: string
  styleDegree?: string
}) {
  // 自定义音色（声音克隆）：路由到本地克隆 TTS 服务
  if (isCustomVoice(voice)) {
    logger.info(`Custom voice synthesis: ${voice} (${text.length} chars, ${outputType})`)
    if (outputType === 'file') {
      await synthesizeCloneVoice(text, voice, { rate, mode: 'buffer', output })
      return {
        audio: output,
        srt: output.replace('.mp3', '.srt'),
        file: '',
      }
    }
    return synthesizeCloneVoice(text, voice, { rate, mode: 'stream' })
  }
  const lang = voice.match(/([a-zA-Z]{2,5}-[a-zA-Z]{2,5}\b)/)?.[1]
  const useStyle = style && supportsStyle(voice) ? style : undefined
  const useStyleDegree = useStyle && styleDegree ? Number(styleDegree) : undefined
  const tts = new EdgeTTS({
    voice,
    lang,
    outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
    saveSubtitles: true,
    pitch,
    rate,
    volume,
    timeout: 30_000,
    style: useStyle,
    styleDegree: useStyleDegree && Number.isFinite(useStyleDegree) ? useStyleDegree : undefined,
  })
  console.log(`run with nodejs edge-tts service...`)
  if (outputType === 'file') {
    await tts.ttsPromise(text, { audioPath: output, outputType })
    return {
      audio: output,
      srt: output.replace('.mp3', '.srt'),
      file: '',
    }
  }
  return tts.ttsPromise(text, { audioPath: output, outputType: outputType as any })
}
export const generateSingleVoice = async (
  params: Omit<EdgeSchema, 'useLLM'> & { output: string }
) => {
  let result: TTSResult = {
    audio: '',
    srt: '',
  }
  await safeRunWithRetry(
    async () => {
      result = (await runEdgeTTS({ ...params })) as TTSResult
    },
    { retries: 5 }
  )
  return result!
}
export const generateSingleVoiceStream = async (
  params: Omit<EdgeSchema, 'useLLM'> & { output: string; outputType?: string }
) => {
  return runEdgeTTS({ ...params, outputType: 'stream' })
}

// 定义字幕数据的类型
interface Subtitle {
  part: string // 字幕文本
  start: number // 开始时间（毫秒）
  end: number // 结束时间（毫秒）
}

/**
 * 将毫秒转换为 SRT 时间格式（HH:MM:SS,MMM）
 * @param ms 毫秒数
 * @returns 格式化的时间字符串
 */
function formatTime(ms: number): string {
  const hours = Math.floor(ms / 3600000)
    .toString()
    .padStart(2, '0')
  const minutes = Math.floor((ms % 3600000) / 60000)
    .toString()
    .padStart(2, '0')
  const seconds = Math.floor((ms % 60000) / 1000)
    .toString()
    .padStart(2, '0')
  const milliseconds = (ms % 1000).toString().padStart(3, '0')
  return `${hours}:${minutes}:${seconds},${milliseconds}`
}

/**
 * 将字幕 JSON 数据转换为 SRT 格式字符串
 * @param subtitles 字幕数组
 * @returns SRT 格式的字符串
 */
function convertToSrt(subtitles: Subtitle[]): string {
  let srtContent = ''

  subtitles.forEach((subtitle, index) => {
    const startTime = formatTime(subtitle.start)
    const endTime = formatTime(subtitle.end)

    srtContent += `${index + 1}\n`
    srtContent += `${startTime} --> ${endTime}\n`
    srtContent += `${subtitle.part}\n\n`
  })

  return srtContent
}

export const jsonToSrt = async (jsonPath: string) => {
  const json = await readJson<any>(jsonPath)
  const srtResult = convertToSrt(json)
  return srtResult
}

export const generateSrt = async (jsonPath: string, srtPath: string, deleteJson = false) => {
  if (await fileExist(srtPath)) {
    console.log(`SRT file already exists at ${srtPath}`)
    return
  }
  try {
    const srtTxt = await jsonToSrt(jsonPath)
    await fs.writeFile(srtPath, srtTxt, 'utf8')
    console.log(`SRT file created at ${srtPath}`)
    if (deleteJson) await fs.unlink(jsonPath)
    return srtPath
  } catch (err) {
    console.error(`Error reading JSON file at ${jsonPath}:`, err)
    return
  }
}
