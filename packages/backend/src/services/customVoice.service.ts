import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import ffmpeg from '../utils/ffmpeg'
import { logger } from '../utils/logger'
import { AUDIO_DIR } from '../config'

/**
 * 自定义音色（声音克隆参考音频）管理。
 * 参考音频统一转码为 24kHz 单声道 wav 后存放在 audio/custom-voices/ 下，
 * 音色 ID 形如 custom-xxxxxxxx；克隆 TTS 服务通过 URL 拉取该 wav 作为说话人参考。
 */

const CUSTOM_VOICES_DIR = path.resolve(AUDIO_DIR, 'custom-voices')
const META_FILE = path.resolve(CUSTOM_VOICES_DIR, 'index.json')
const ID_PATTERN = /^custom-[a-z0-9]+$/
const ALLOWED_EXTS = ['.wav', '.mp3', '.m4a', '.flac', '.ogg']

export interface CustomVoiceEntry {
  /** 音色 ID，即 TTS 调用时 voice 字段的取值（custom-xxx） */
  id: string
  name: string
  /** 等同于 id，方便前端把音色当作 voice 字段直接使用 */
  voice: string
  file: string
  createdAt: string
}

async function readIndex(): Promise<Record<string, CustomVoiceEntry>> {
  try {
    return JSON.parse(await fs.readFile(META_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

async function writeIndex(index: Record<string, CustomVoiceEntry>): Promise<void> {
  await fs.mkdir(CUSTOM_VOICES_DIR, { recursive: true })
  await fs.writeFile(META_FILE, JSON.stringify(index, null, 2), 'utf-8')
}

/** 上传/更新自定义音色：任意常见音频格式自动转码为 24kHz 单声道 wav */
export async function saveCustomVoice(
  name: string,
  buffer: Buffer,
  ext: string
): Promise<CustomVoiceEntry> {
  const cleanName = name.trim().slice(0, 30) || '我的音色'
  const lowerExt = ext.toLowerCase()
  if (!ALLOWED_EXTS.includes(lowerExt)) {
    throw new Error(`仅支持 ${ALLOWED_EXTS.join(' / ')} 音频格式`)
  }
  const slug =
    cleanName
      .replace(/\s+/g, '-')
      .replace(/[^\w\u4e00-\u9fff-]/g, '')
      .slice(0, 30) || 'voice'
  const id = `custom-${crypto.createHash('sha256').update(slug).digest('hex').slice(0, 8)}`

  await fs.mkdir(CUSTOM_VOICES_DIR, { recursive: true })
  const uploadFile = path.resolve(CUSTOM_VOICES_DIR, `upload-${id}${lowerExt}`)
  const wavFile = path.resolve(CUSTOM_VOICES_DIR, `${id}.wav`)
  await fs.writeFile(uploadFile, buffer)
  await new Promise<void>((resolve, reject) => {
    ffmpeg(uploadFile)
      .audioChannels(1)
      .audioFrequency(24000)
      .on('error', (err) => reject(new Error(`音频转码失败：${err.message}`)))
      .on('end', () => resolve())
      .save(wavFile)
  })
  await fs.rm(uploadFile, { force: true })
  await fs.access(wavFile)

  const index = await readIndex()
  const entry: CustomVoiceEntry = {
    id,
    name: cleanName,
    voice: id,
    file: `${id}.wav`,
    createdAt: index[id]?.createdAt || new Date().toISOString(),
  }
  index[id] = entry
  await writeIndex(index)
  logger.info(`Custom voice saved: ${id} (${cleanName})`)
  return entry
}

export async function listCustomVoices(): Promise<CustomVoiceEntry[]> {
  const index = await readIndex()
  return Object.values(index).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
}

export async function deleteCustomVoice(id: string): Promise<void> {
  if (!ID_PATTERN.test(id)) throw new Error('无效的音色 ID')
  const index = await readIndex()
  if (!index[id]) throw new Error('未找到该自定义音色')
  await fs.rm(path.resolve(CUSTOM_VOICES_DIR, index[id].file), { force: true })
  delete index[id]
  await writeIndex(index)
  logger.info(`Custom voice deleted: ${id}`)
}

/** 校验 ID 并返回参考音频绝对路径（供克隆服务以 URL 拉取前的存在性校验） */
export async function getCustomVoiceFile(id: string): Promise<string | null> {
  if (!ID_PATTERN.test(id)) return null
  const index = await readIndex()
  const entry = index[id]
  if (!entry) return null
  const file = path.resolve(CUSTOM_VOICES_DIR, entry.file)
  try {
    await fs.access(file)
    return file
  } catch {
    return null
  }
}
