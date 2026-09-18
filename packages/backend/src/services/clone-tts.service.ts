import fs from 'fs/promises'
import path from 'path'
import { Readable } from 'stream'
import { logger } from '../utils/logger'
import { fetcher } from '../utils/request'
import { listCustomVoices } from './customVoice.service'

/**
 * 声音克隆合成：对接本地克隆 TTS 服务的 OpenAI 兼容接口
 * （参考实现：xtts-api-server，POST /audio/speech，voice 传说话人参考 wav 的 URL）。
 * 服务地址与参考音频访问前缀在设置页配置，落盘 data/clone-settings.json，重启自动恢复。
 */

const SETTINGS_FILE = path.resolve(__dirname, '../../data/clone-settings.json')

export interface CloneSettings {
  /** 克隆 TTS 服务地址，如 http://127.0.0.1:8020 */
  baseUrl?: string
  /** 合成语言，如 zh */
  language?: string
  /** 克隆服务拉取参考 wav 的地址前缀（指向 EasyVoice 的 audio 静态服务） */
  wavUrlPrefix?: string
}

async function readSettings(): Promise<CloneSettings> {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

async function writeSettings(settings: CloneSettings): Promise<void> {
  await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true })
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8')
}

export async function getCloneSettings(): Promise<Required<CloneSettings>> {
  const stored = await readSettings()
  return {
    baseUrl: stored.baseUrl || '',
    language: stored.language || 'zh',
    // 克隆服务容器通过 host.docker.internal 访问宿主机上的 EasyVoice 静态音频
    wavUrlPrefix: stored.wavUrlPrefix || 'http://host.docker.internal:3000',
  }
}

export async function saveCloneSettings(patch: CloneSettings): Promise<Required<CloneSettings>> {
  const current = await readSettings()
  const next: CloneSettings = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') delete next[key as keyof CloneSettings]
    else next[key as keyof CloneSettings] = value as never
  }
  await writeSettings(next)
  logger.info('Clone TTS settings updated', { baseUrl: next.baseUrl, language: next.language })
  return getCloneSettings()
}

export function isCustomVoice(voice: string): boolean {
  return voice.startsWith('custom-')
}

function rateToSpeed(rate?: string): number {
  const percent = Number((rate || '+0%').replace('%', ''))
  if (!Number.isFinite(percent)) return 1.0
  return Math.min(3, Math.max(0.5, Number((1 + percent / 100).toFixed(2))))
}

/**
 * 用自定义音色合成语音。对接 daswer123/xtts-api-server 协议：
 * POST /tts_to_audio/ JSON {text, speaker_wav(容器内绝对路径), language, speed} -> wav 音频。
 * 参考音频目录已挂载到容器的 /app/speakers。
 */
export async function synthesizeCloneVoice(
  text: string,
  voice: string,
  opts: { rate?: string; mode: 'stream' | 'buffer'; output?: string }
): Promise<Readable | Buffer> {
  const settings = await getCloneSettings()
  if (!settings.baseUrl) {
    throw new Error(
      '未配置声音克隆服务地址，请先在有声书页面的「声音克隆」卡片中完成配置'
    )
  }
  const voices = await listCustomVoices()
  const entry = voices.find((v) => v.voice === voice)
  if (!entry) throw new Error(`未找到自定义音色：${voice}`)

  const body = {
    text,
    speaker_wav: `/app/speakers/${entry.file}`,
    language: settings.language || 'zh-cn',
    speed: rateToSpeed(opts.rate),
  }
  logger.info(
    `Clone TTS request: ${settings.baseUrl}/tts_to_audio/ (${text.length} chars, voice=${voice})`
  )
  const response = await fetcher.post(
    `${settings.baseUrl.replace(/\/$/, '')}/tts_to_audio/`,
    body,
    {
      responseType: opts.mode === 'stream' ? 'stream' : 'arraybuffer',
      timeout: 600_000,
    }
  )
  logger.info(`Clone TTS response: status=${response.status}`)
  if (opts.mode === 'stream') {
    return response.data as Readable
  }
  const buffer = Buffer.from(response.data)
  if (opts.output) {
    await fs.writeFile(opts.output, buffer)
  }
  return buffer
}
