import fs from 'fs/promises'
import { EdgeSchema } from '../schema/generate'
import { EdgeTTS } from '../lib/node-edge-tts/edge-tts-fixed'
import { fileExist, readJson, safeRunWithRetry } from '../utils'
import { logger } from '../utils/logger'
import { isCustomVoice, synthesizeCloneVoice } from './clone-tts.service'
import { getVoicePreset, isPresetVoice } from './voicePreset.service'

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

// 旁白类风格目前仅晓伊（Xiaoxiao）支持，其他音色携带会被微软端以 SSML invalid (1007) 拒绝
const NARRATION_STYLES = [
  'narration-professional',
  'narration-relaxed',
  'documentary-narration',
]

function supportsStyle(voice: string, style?: string): boolean {
  if (!STYLE_SUPPORTED_VOICE_PATTERNS.some((pattern) => voice.includes(pattern))) return false
  if (style && NARRATION_STYLES.includes(style)) return voice.includes('XiaoxiaoNeural')
  return true
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
  lang,
}: Omit<EdgeSchema, 'useLLM'> & {
  output: string
  outputType?: string
  style?: string
  styleDegree?: string
  lang?: string
}) {
  // 自定义音色（声音克隆）：路由到本地克隆 TTS 服务
  if (isCustomVoice(voice)) {
    logger.info(`Custom voice synthesis: ${voice} (${text.length} chars, ${outputType})`)
    if (outputType === 'file') {
      // file 模式返回与 Edge 分支一致的 TTSResult 结构
      await synthesizeCloneVoice(text, voice, { rate, mode: 'buffer', output })
      return {
        audio: output,
        srt: output.replace('.mp3', '.srt'),
        file: '',
      }
    }
    // buffer 模式必须返回 Buffer；stream 模式返回 axios 流（IncomingMessage）
    if (outputType === 'buffer') {
      return synthesizeCloneVoice(text, voice, { rate, mode: 'buffer' })
    }
    return synthesizeCloneVoice(text, voice, { rate, mode: 'stream' })
  }
  // 自定义 Edge 音色预设：还原为基础音色并叠加预设的 语速/音调/音量/风格
  if (isPresetVoice(voice)) {
    const preset = await getVoicePreset(voice)
    if (!preset) throw new Error(`未找到自定义 Edge 音色：${voice}，可能已被删除`)
    logger.info(`Preset voice synthesis: ${voice} -> ${preset.voice} (${text.length} chars)`)
    voice = preset.voice
    rate = preset.rate || rate
    pitch = preset.pitch || pitch
    volume = preset.volume || volume
    style = preset.style || style
  }
  const useStyle = style && supportsStyle(voice, style) ? style : undefined
  const useStyleDegree = useStyle && styleDegree ? Number(styleDegree) : undefined
  const buildTts = (withStyle?: string) =>
    new EdgeTTS({
      voice,
      lang,
      outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
      saveSubtitles: true,
      pitch,
      rate,
      volume,
      timeout: 30_000,
      style: withStyle,
      styleDegree: withStyle && useStyleDegree && Number.isFinite(useStyleDegree) ? useStyleDegree : undefined,
    })
  console.log(`run with nodejs edge-tts service...`)
  if (outputType === 'file') {
    try {
      await buildTts(useStyle).ttsPromise(text, { audioPath: output, outputType })
    } catch (err) {
      // 兜底：个别音色×风格组合被微软端拒绝（SSML invalid），去风格重试一次
      if (!useStyle) throw err
      logger.warn(
        `Style "${useStyle}" rejected for ${voice} (${(err as Error).message}), retrying without style`
      )
      await buildTts(undefined).ttsPromise(text, { audioPath: output, outputType })
    }
    return {
      audio: output,
      srt: output.replace('.mp3', '.srt'),
      file: '',
    }
  }
  if (outputType === 'buffer') {
    try {
      return await buildTts(useStyle).ttsPromise(text, { outputType: 'buffer' })
    } catch (err) {
      if (!useStyle) throw err
      logger.warn(`Style "${useStyle}" rejected for ${voice}, retrying without style`)
      return await buildTts(undefined).ttsPromise(text, { outputType: 'buffer' })
    }
  }
  return buildTts(useStyle).ttsPromise(text, { audioPath: output, outputType: outputType as any })
}

/** 一次性合成整段音频（带风格被拒时去风格重试），适合短文本试听场景 */
export const generateSingleVoiceBuffer = async (params: {
  text: string
  voice: string
  rate?: string
  pitch?: string
  volume?: string
  style?: string
  styleDegree?: string
  lang?: string
}): Promise<Buffer> => {
  const result = (await safeRunWithRetry(
    () => runEdgeTTS({ ...params, output: '', outputType: 'buffer' }) as Promise<Buffer>,
    { retries: 2, baseDelayMs: 500 }
  )) as Buffer
  return result!
}

/**
 * 自定义 Edge 音色试听：直接用表单当前值合成一小段音频（不要求先保存）。
 * 供「自定义音色」卡片在保存前试听效果。
 */
export async function previewPresetVoice(params: {
  voice: string
  rate?: string
  pitch?: string
  volume?: string
  style?: string
  text?: string
}): Promise<Buffer> {
  const useStyle = params.style && supportsStyle(params.voice, params.style) ? params.style : undefined
  const buildTts = (withStyle?: string) =>
    new EdgeTTS({
      voice: params.voice,
      outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
      saveSubtitles: false,
      rate: params.rate || '+0%',
      pitch: params.pitch || '+0Hz',
      volume: params.volume || '+0%',
      timeout: 30_000,
      style: withStyle,
    })
  const text = params.text || '你好，这是一段自定义音色的试听效果。'
  try {
    return (await buildTts(useStyle).ttsPromise(text, { outputType: 'buffer' })) as Buffer
  } catch (err) {
    // 兜底：风格被微软端拒绝时去风格重试一次
    if (!useStyle) throw err
    logger.warn(
      `Preview style "${useStyle}" rejected for ${params.voice}, retrying without style`
    )
    return (await buildTts(undefined).ttsPromise(text, { outputType: 'buffer' })) as Buffer
  }
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
