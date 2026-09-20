import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { logger } from '../utils/logger'

/**
 * 自定义 Edge 音色预设：基于任意 Edge-TTS 内置音色，叠加 语速/音调/音量/情感风格 参数，
 * 保存为一个可直接选用的「音色」。生成速度与普通 Edge 音色一致（无需克隆推理），
 * 可用于有声书角色配音与 AI 智能配音。落盘 data/voice-presets.json，重启自动恢复。
 */

const PRESETS_FILE = path.resolve(__dirname, '../../data/voice-presets.json')

/** mstts:express-as 常用情感风格（仅部分微软音色支持；合成时对不支持的音色自动忽略） */
export const EXPRESS_AS_STYLES = [
  'cheerful',
  'sad',
  'angry',
  'fearful',
  'disgruntled',
  'serious',
  'affectionate',
  'gentle',
  'calm',
  'lyrical',
  'narration-professional',
  'narration-relaxed',
  'documentary-narration',
]

export interface VoicePreset {
  /** 音色 ID（edge-xxxxxxxx），即各处 voice 字段的取值 */
  id: string
  name: string
  /** 基础 Edge 音色（voice.json 中的 Name，如 zh-CN-YunxiNeural） */
  voice: string
  /** 语速，如 +10% / -15% */
  rate?: string
  /** 音调，如 +20Hz / -10Hz */
  pitch?: string
  /** 音量，如 +10% */
  volume?: string
  /** 情感风格（express-as） */
  style?: string
  /** Male / Female（默认继承基础音色，供 AI 配音性别匹配） */
  gender?: string
  createdAt: string
}

const RATE_PATTERN = /^[+-]?\d{1,3}%$/
const PITCH_PATTERN = /^[+-]?\d{1,3}Hz$/i

async function readIndex(): Promise<Record<string, VoicePreset>> {
  try {
    return JSON.parse(await fs.readFile(PRESETS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

async function writeIndex(index: Record<string, VoicePreset>): Promise<void> {
  await fs.mkdir(path.dirname(PRESETS_FILE), { recursive: true })
  await fs.writeFile(PRESETS_FILE, JSON.stringify(index, null, 2), 'utf-8')
}

export function isPresetVoice(voice: string): boolean {
  return voice.startsWith('edge-')
}

export async function getVoicePreset(id: string): Promise<VoicePreset | null> {
  if (!isPresetVoice(id)) return null
  const index = await readIndex()
  return index[id] || null
}

export async function listVoicePresets(): Promise<VoicePreset[]> {
  const index = await readIndex()
  return Object.values(index).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export interface SaveVoicePresetInput {
  name: string
  voice: string
  rate?: string
  pitch?: string
  volume?: string
  style?: string
  gender?: string
}

const clean = (v?: string) => (v || '').trim()

/** 新建/更新预设：同名（同名即同 ID）覆盖。返回保存后的完整条目 */
export async function saveVoicePreset(input: SaveVoicePresetInput): Promise<VoicePreset> {
  const name = clean(input.name).slice(0, 30)
  const voice = clean(input.voice)
  if (!name) throw new Error('请填写音色名称')
  if (!voice) throw new Error('请选择基础音色')
  const rate = clean(input.rate)
  if (rate && !RATE_PATTERN.test(rate)) throw new Error('语速格式应为 +10% 或 -15%')
  const pitch = clean(input.pitch)
  if (pitch && !PITCH_PATTERN.test(pitch)) throw new Error('音调格式应为 +20Hz 或 -10Hz')
  const volume = clean(input.volume)
  if (volume && !RATE_PATTERN.test(volume)) throw new Error('音量格式应为 +10%')
  const style = clean(input.style)
  if (style && !EXPRESS_AS_STYLES.includes(style)) throw new Error('不支持的情感风格')

  const slug = name.replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fff-]/g, '').slice(0, 30) || 'preset'
  const id = `edge-${crypto.createHash('sha256').update(slug).digest('hex').slice(0, 8)}`
  const index = await readIndex()
  const entry: VoicePreset = {
    id,
    name,
    voice,
    ...(rate ? { rate } : {}),
    ...(pitch ? { pitch } : {}),
    ...(volume ? { volume } : {}),
    ...(style ? { style } : {}),
    gender: clean(input.gender) || undefined,
    createdAt: index[id]?.createdAt || new Date().toISOString(),
  }
  index[id] = entry
  await writeIndex(index)
  logger.info(`Voice preset saved: ${id} (${name} -> ${voice})`)
  return entry
}

export async function deleteVoicePreset(id: string): Promise<void> {
  if (!isPresetVoice(id)) throw new Error('无效的音色 ID')
  const index = await readIndex()
  if (!index[id]) throw new Error('未找到该自定义音色')
  delete index[id]
  await writeIndex(index)
  logger.info(`Voice preset deleted: ${id}`)
}
