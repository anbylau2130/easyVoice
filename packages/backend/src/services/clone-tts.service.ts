import fs from 'fs/promises'
import path from 'path'
import { Readable } from 'stream'
import { logger } from '../utils/logger'
import { postToCloneService } from '../utils/clone-http'
import { listCustomVoices } from './customVoice.service'

/**
 * 声音克隆合成：对接本地克隆 TTS 服务（参考实现：daswer123/xtts-api-server）。
 * 服务地址与参考音频访问前缀在设置页配置，落盘 data/clone-settings.json，重启自动恢复。
 * 对克隆服务的所有请求经由 utils/clone-http 统一出口（出口处含安全终校验）。
 */

const SETTINGS_FILE = path.resolve(__dirname, '../../data/clone-settings.json')

export interface CloneSettings {
  /** 克隆 TTS 服务地址，如 compose 内 http://xtts-server:8020 */
  baseUrl?: string
  /** 合成语言，如 zh-cn */
  language?: string
  /** 克隆服务容器内说话人目录（挂载的 EasyVoice custom-voices） */
  speakersDir?: string
  /** 参考音频 URL 前缀（克隆服务通过该前缀 HTTP 拉取参考音频，免目录挂载） */
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
    // 克隆服务容器内看到的说话人目录（compose 挂载整个 audio 卷，参考音频在其 custom-voices 子目录）
    speakersDir: stored.speakersDir || process.env.TTS_CLONE_SPEAKERS_DIR || '/app/speakers/custom-voices',
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

/** 私网/环回地址识别（与 utils/clone-http 出口校验保持一致） */
const PRIVATE_HOST_PATTERN =
  /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|\[::1\]$|host\.docker\.internal$)/i

export interface CloneTargetCheck {
  ok: boolean
  message?: string
  url?: URL
}

/**
 * 克隆服务目标地址入口校验（allowlist）：
 * 1. 仅允许 http/https 协议；
 * 2. 始终拒绝云元数据地址（169.254.169.254，SSRF 防护）；
 * 3. 私网/环回地址默认允许——自部署单用户场景下，克隆 TTS 服务运行在本机或局域网是核心用法；
 *    需要严格封禁私网时设置环境变量 TTS_CLONE_STRICT=1（请求出口 utils/clone-http 同样强制执行）。
 */
export function validateCloneBaseUrl(raw: string): CloneTargetCheck {
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
  if (process.env.TTS_CLONE_STRICT === '1' && PRIVATE_HOST_PATTERN.test(url.hostname)) {
    return { ok: false, message: '严格模式下不允许访问内网地址（TTS_CLONE_STRICT=1）' }
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
      '/app/speakers/custom-voices',
    wavUrlPrefix: patch.wavUrlPrefix?.trim() || current.wavUrlPrefix || '',
  }

  if (!base.baseUrl) return { ok: false, message: '请先填写克隆服务地址', latencyMs: 0 }
  // 入口校验：仅 http/https、拒绝元数据地址、私网策略；请求出口处还有二次校验
  const target = validateCloneBaseUrl(base.baseUrl)
  if (!target.ok || !target.url)
    return { ok: false, message: target.message || '克隆服务地址无效', latencyMs: 0 }

  const voices = await listCustomVoices()
  if (!voices.length)
    return { ok: false, message: '还没有上传参考音频（自定义音色）', latencyMs: 0 }

  // speaker_wav 一律使用克隆服务容器内路径（实测该服务不支持 URL 拉取参考音频）
  const speakerWav = `${base.speakersDir.replace(/\/$/, '')}/${voices[0].file}`

  const start = Date.now()
  try {
    const response = await postToCloneService(
      target.url,
      {
        text: '测试。',
        speaker_wav: speakerWav,
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
 * POST /tts_to_audio/ JSON {text, speaker_wav, language, speed} -> wav 音频。
 * speaker_wav 支持两种形态：参考音频的 HTTP URL（配置了 wavUrlPrefix 时，克隆服务自行拉取）
 * 或克隆服务容器内绝对路径（speakers 目录已挂载时）。
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

  // 复校已存储地址（防绕过设置页校验的手工篡改）；请求出口 utils/clone-http 处还有二次校验
  const target = validateCloneBaseUrl(settings.baseUrl)
  if (!target.ok || !target.url) throw new Error(`克隆服务地址无效：${target.message}`)

  // speaker_wav 一律使用克隆服务容器内路径（speakers 目录挂载）。
  // 实测 daswer123/xtts-api-server 不支持 URL 拉取参考音频（会把 URL 当相对路径打开导致 500），
  // 因此 wavUrlPrefix 仅作存储保留，不参与合成。
  const speakerWav = `${settings.speakersDir.replace(/\/$/, '')}/${entry.file}`

  const body = {
    text,
    speaker_wav: speakerWav,
    language: settings.language || 'zh-cn',
    speed: rateToSpeed(opts.rate),
  }
  logger.info(
    `Clone TTS request: ${target.url.origin}/tts_to_audio/ (${text.length} chars, voice=${voice})`
  )
  let response
  try {
    response = await postToCloneService(target.url, body, {
      responseType: opts.mode === 'stream' ? 'stream' : 'arraybuffer',
      timeout: 600_000,
    })
  } catch (err) {
    // 透出克隆服务返回的具体错误（如参考音频缺失、语言不支持），避免前端只看到笼统的 500。
    // arraybuffer 响应下 err.response.data 是 Buffer，需要先转文本再解析 JSON
    const ax = err as { response?: { status?: number; data?: unknown }; message?: string }
    const data = ax?.response?.data
    let detail: string | undefined
    if (typeof data === 'string') {
      try {
        detail = JSON.parse(data)?.detail
      } catch {
        detail = data.slice(0, 200)
      }
    } else if (Buffer.isBuffer(data)) {
      try {
        detail = JSON.parse(data.toString('utf-8'))?.detail
      } catch {
        detail = undefined
      }
    } else if (data && typeof data === 'object' && 'detail' in (data as Record<string, unknown>)) {
      detail = String((data as Record<string, unknown>).detail)
    }
    throw new Error(`克隆服务合成失败：${detail || ax?.message || '未知错误'}`)
  }
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
