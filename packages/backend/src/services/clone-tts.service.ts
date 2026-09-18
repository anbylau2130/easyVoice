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
  /** 克隆 TTS 服务地址，如 compose 内 http://xtts-server:8020 */
  baseUrl?: string
  /** 合成语言，如 zh-cn */
  language?: string
  /** 克隆服务容器内说话人目录（挂载的 EasyVoice custom-voices） */
  speakersDir?: string
  /** 参考音频 URL 前缀（服务端通过 URL 拉取参考音频时使用） */
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
    baseUrl: stored.baseUrl || process.env.TTS_CLONE_URL || '',
    language: normalizeLanguage(stored.language || process.env.TTS_CLONE_LANGUAGE || 'zh-cn'),
    // 克隆服务容器内看到的说话人目录（compose 默认卷挂载路径）
    speakersDir: stored.speakersDir || process.env.TTS_CLONE_SPEAKERS_DIR || '/app/speakers',
    wavUrlPrefix: stored.wavUrlPrefix || process.env.TTS_CLONE_WAV_URL_PREFIX || '',
  }
}

/** daswer123/XTTS 只接受完整语言码：zh -> zh-cn */
function normalizeLanguage(value: string): string {
  const v = (value || '').trim().toLowerCase()
  if (v === 'zh' || v === 'zh-cn' || v === 'chinese') return 'zh-cn'
  return v || 'zh-cn'
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

/**
 * 克隆服务地址校验：仅 http/https；拒绝云元数据地址（169.254.169.254，SSRF 防护）。
 * localhost/内网地址允许——自部署场景下用户在本机或局域网机器运行 TTS 服务是核心用法。
 */
export function validateCloneBaseUrl(raw: string): { ok: boolean; message?: string; url?: URL } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, message: '克隆服务地址格式无效' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, message: '仅支持 http/https 协议' }
  }
  if (url.hostname === '169.254.169.254') {
    return { ok: false, message: '不允许的地址' }
  }
  return { ok: true, url }
}

export interface CloneTestResult {
  ok: boolean
  message: string
  latencyMs: number
}

/**
 * 克隆服务连通性测试：用第一个参考音频合成一句短文本，
 * 验证 服务可达 → 模型加载 → 推理 → 返回有效音频 的完整链路。
 * patch 传入表单当前值（不落盘），可测试未保存的配置。
 */
export async function testCloneService(
  patch: Partial<CloneSettings> = {}
): Promise<CloneTestResult> {
  const current = await readSettings()
  const base: Required<CloneSettings> = {
    baseUrl: patch.baseUrl?.trim() || current.baseUrl || process.env.TTS_CLONE_URL || '',
    language: normalizeLanguage(
      patch.language?.trim() || current.language || process.env.TTS_CLONE_LANGUAGE || 'zh-cn'
    ),
    speakersDir:
      patch.speakersDir?.trim() ||
      current.speakersDir ||
      process.env.TTS_CLONE_SPEAKERS_DIR ||
      '/app/speakers',
    wavUrlPrefix: patch.wavUrlPrefix?.trim() || current.wavUrlPrefix || '',
  }

  if (!base.baseUrl) return { ok: false, message: '请先填写克隆服务地址', latencyMs: 0 }
  const check = validateCloneBaseUrl(base.baseUrl)
  if (!check.ok) return { ok: false, message: check.message || '克隆服务地址无效', latencyMs: 0 }

  const voices = await listCustomVoices()
  if (!voices.length)
    return { ok: false, message: '还没有上传参考音频（自定义音色）', latencyMs: 0 }

  const start = Date.now()
  try {
    const response = await fetcher.post(
      `${base.baseUrl.replace(/\/$/, '')}/tts_to_audio/`,
      {
        text: '测试。',
        speaker_wav: `${base.speakersDir.replace(/\/$/, '')}/${voices[0].file}`,
        language: base.language,
      },
      { responseType: 'arraybuffer', timeout: 120_000 }
    )
    const status = response.status
    const buf = Buffer.from(response.data)
    if (status !== 200 || buf.length < 1000) {
      return {
        ok: false,
        message: `服务响应异常（HTTP ${status}, ${buf.length} bytes）`,
        latencyMs: Date.now() - start,
      }
    }
    return {
      ok: true,
      message: `连接成功，XTTS 合成正常（${buf.length} bytes 音频）`,
      latencyMs: Date.now() - start,
    }
  } catch (err) {
    const ax = err as { response?: { status?: number; data?: { detail?: string } }; message?: string }
    const detail = ax?.response?.data?.detail || ax?.message || '未知错误'
    return { ok: false, message: String(detail), latencyMs: Date.now() - start }
  }
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
