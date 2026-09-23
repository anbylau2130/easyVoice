import fs from 'fs/promises'
import path from 'node:path'
import axios from 'axios'
import ffmpeg from '../utils/ffmpeg'
import { logger } from '../utils/logger'

/**
 * 音色转换（Voice Conversion）客户端：调用独立转换服务完成频谱级换声。
 * 管线：edge-tts 合成基础音频 → 本服务调用转换服务 → 得到目标音色音频。
 * 各引擎独立部署，互不影响：
 *  - openvoice → vc-server（OpenVoice2 零样本换声，ref 为参考音频名，相似度中等，启动即用）
 *  - rvc → rvc-server（RVC v2 模型换声，ref 为已训练模型名，相似度更高、CPU 推理更快）
 * 另有 omnivoice → omnivoice-server：非转换路线，而是「文本+参考音频」一步克隆合成
 *（零样本 TTS，不能对已有音频换声），见下方 generateOmniVoice 系列函数。
 */

// 各合成/转换服务的地址均为服务端配置的内网地址（docker 网络/本机回环），
// 仅运维可通过环境变量修改，非用户输入。显式校验协议防止误配置。
function resolveServiceBase(raw: string, name: string): URL {
  const url = new URL(raw)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} 仅支持 http/https 协议`)
  }
  if (url.username || url.password) {
    throw new Error(`${name} 不允许携带凭据`)
  }
  return url
}

const VC_BASE = resolveServiceBase(process.env.VC_SERVER_URL || 'http://127.0.0.1:9090', 'VC_SERVER_URL')
const RVC_BASE = resolveServiceBase(process.env.RVC_SERVER_URL || 'http://127.0.0.1:9091', 'RVC_SERVER_URL')
const OMNI_BASE = resolveServiceBase(
  process.env.OMNIVOICE_SERVER_URL || 'http://127.0.0.1:9092',
  'OMNIVOICE_SERVER_URL'
)
const VC_TIMEOUT_MS = 120_000

/** 在指定服务的基址上拼接固定路径（路径为代码内常量，不拼接用户输入） */
function serviceUrl(
  engine: VcEngine | 'omnivoice',
  fixedPath:
    | '/references'
    | '/models'
    | '/convert'
    | '/generate'
    | '/health'
    | '/designs'
    | '/designs/sample'
    | '/designs/delete'
    | '/design-preview'
): string {
  const base = engine === 'rvc' ? RVC_BASE : engine === 'omnivoice' ? OMNI_BASE : VC_BASE
  const url = new URL(base)
  url.pathname = `${url.pathname.replace(/\/$/, '')}${fixedPath}`
  return url.toString()
}

export type VcEngine = 'openvoice' | 'rvc'

export interface VcConvertOptions {
  engine: VcEngine
  /** openvoice=参考音频名 / rvc=模型名 */
  ref: string
  /** 变调半音数（跨性别换声时 ±12 可显著提升相似度），仅 rvc 引擎生效 */
  pitch?: number
}

export function isVcEngine(value: unknown): value is VcEngine {
  return value === 'openvoice' || value === 'rvc'
}

export async function listVcReferences(): Promise<string[]> {
  try {
    const resp = await fetch(serviceUrl('openvoice', '/references'), {
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as { references?: string[] }
    return data.references || []
  } catch (error) {
    logger.warn(`List VC references failed: ${(error as Error).message}`)
    return []
  }
}

export interface VcModelInfo {
  /** 模型名（即转换时的 ref） */
  name: string
  hasIndex: boolean
}

export async function listVcModels(): Promise<VcModelInfo[]> {
  try {
    const resp = await fetch(serviceUrl('rvc', '/models'), {
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as { models?: VcModelInfo[] }
    return data.models || []
  } catch (error) {
    logger.warn(`List VC models failed: ${(error as Error).message}`)
    return []
  }
}

function ffmpegToWav(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioChannels(1)
      .audioFrequency(24000)
      .on('error', (err) => reject(new Error(`音频转码失败：${err.message}`)))
      .on('end', () => resolve())
      .save(output)
  })
}

function ffmpegToMp3(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(input)
      .audioChannels(1)
      .audioFrequency(24000)
      .audioBitrate(96)
      .format('mp3')
      .on('error', (err) => reject(new Error(`音频转码失败：${err.message}`)))
      .on('end', () => resolve())
      .save(output)
  })
}

/**
 * 调用 vc-server 转换单个音频文件（mp3 进、mp3 出）。
 * @param inputMp3 已合成的 mp3 文件路径
 * @returns 转换后的 mp3 路径（`原名_vc.mp3`，与原文件并存以保留字幕时轴基准）
 */
export async function convertAudioFile(inputMp3: string, opts: VcConvertOptions): Promise<string> {
  const outMp3 = inputMp3.replace(/\.mp3$/i, '_vc.mp3')
  const srcWav = inputMp3.replace(/\.mp3$/i, '_vc_src.wav')
  const outWav = inputMp3.replace(/\.mp3$/i, '_vc_out.wav')
  try {
    // vc-server 统一以 24kHz 单声道 wav 处理
    await ffmpegToWav(inputMp3, srcWav)
    const form = new FormData()
    form.append('engine', opts.engine)
    form.append('ref', opts.ref)
    if (typeof opts.pitch === 'number' && opts.pitch !== 0) {
      form.append('pitch', String(opts.pitch))
    }
    form.append('audio', new Blob([await fs.readFile(srcWav)], { type: 'audio/wav' }), 'audio.wav')
    const resp = await fetch(serviceUrl(opts.engine, '/convert'), {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(VC_TIMEOUT_MS),
    })
    if (!resp.ok) {
      throw new Error(`vc-server 返回 ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
    }
    const wav = Buffer.from(await resp.arrayBuffer())
    if (!wav.length) throw new Error('vc-server 返回空音频')
    await fs.writeFile(outWav, wav)
    await ffmpegToMp3(outWav, outMp3)
    logger.info(
      `Voice converted: ${path.basename(inputMp3)} -> ${path.basename(outMp3)} (${opts.engine}/${opts.ref})`
    )
    return outMp3
  } finally {
    await fs.rm(srcWav, { force: true })
    await fs.rm(outWav, { force: true })
  }
}

/** 试听场景：转换音频 Buffer（mp3 进，vc-server 端自动解码），返回 wav Buffer（前端可直接播放） */
export async function convertAudioBuffer(input: Buffer, opts: VcConvertOptions): Promise<Buffer> {
  const form = new FormData()
  form.append('engine', opts.engine)
  form.append('ref', opts.ref)
  if (typeof opts.pitch === 'number' && opts.pitch !== 0) {
    form.append('pitch', String(opts.pitch))
  }
  form.append('audio', new Blob([input], { type: 'audio/mpeg' }), 'audio.mp3')
  const resp = await fetch(serviceUrl(opts.engine, '/convert'), {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(VC_TIMEOUT_MS),
  })
  if (!resp.ok) {
    throw new Error(`vc-server 返回 ${resp.status}: ${(await resp.text()).slice(0, 200)}`)
  }
  const wav = Buffer.from(await resp.arrayBuffer())
  if (!wav.length) throw new Error('vc-server 返回空音频')
  return wav
}

// ===== OmniVoice（omnivoice 引擎）：文本+参考音频一步克隆合成 =====

export interface OmniGenerateOptions {
  /** 参考音色名（voices/ 中 wav 文件名不含扩展名，与 OpenVoice 换声源同一命名） */
  ref: string
  /** 语速（Edge 风格如 +10%），换算为 OmniVoice 的 speed 倍率 */
  rate?: string
}

/** OmniVoice 参考音色列表（与 vc-server 共用 voices/ 目录、同一命名） */
export async function listOmniReferences(): Promise<string[]> {
  try {
    const resp = await fetch(serviceUrl('omnivoice', '/references'), {
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as { references?: string[] }
    return data.references || []
  } catch (error) {
    logger.warn(`List OmniVoice references failed: ${(error as Error).message}`)
    return []
  }
}

function rateToSpeed(rate?: string): number {
  const percent = Number((rate || '+0%').replace('%', ''))
  if (!Number.isFinite(percent)) return 1.0
  return Math.min(3, Math.max(0.5, Number((1 + percent / 100).toFixed(2))))
}

// 服务端推理为全局串行（锁内执行）：并发发送的请求会在服务端排队。
// 用后端队列串行发送，保证排队时间不参与请求超时；同时不设请求超时——
// CPU 合成单段可达数分钟、一章可达小时级，与「章节生成等待完成而非砍掉」
// 的策略一致；服务不可达/宕机会立刻以连接错误失败，触发上层 Edge 回落
let omniQueue: Promise<unknown> = Promise.resolve()
function enqueueOmniTask<T>(task: () => Promise<T>): Promise<T> {
  const run = omniQueue.then(task, task)
  omniQueue = run.catch(() => {})
  return run
}

/** OmniVoice 一步克隆合成：文本+参考音频 → wav Buffer（试听场景直接播放） */
export async function generateOmniVoiceBuffer(text: string, opts: OmniGenerateOptions): Promise<Buffer> {
  return enqueueOmniTask(async () => {
    const form = new FormData()
    form.append('text', text)
    form.append('ref', opts.ref)
    form.append('speed', String(rateToSpeed(opts.rate)))
    // 用 axios 而非 fetch：undici fetch 有 300 秒响应头硬限制，慢于 5 分钟的
    // CPU 合成会被无端砍断；axios（node:http）无此限制
    const resp = await axios.post(serviceUrl('omnivoice', '/generate'), form, {
      timeout: 0,
      responseType: 'arraybuffer',
      maxBodyLength: Infinity,
    })
    const wav = Buffer.from(resp.data)
    if (!wav.length) throw new Error('omnivoice-server 返回空音频')
    return wav
  })
}

/**
 * OmniVoice 一步克隆合成到文件：wav → 24kHz 单声道 mp3（章节片段输出路径与 Edge 片段一致）
 * @returns 合成的 mp3 路径（即 opts.output）
 */
export async function generateOmniVoiceSegment(
  text: string,
  opts: OmniGenerateOptions & { output: string }
): Promise<string> {
  const wav = await generateOmniVoiceBuffer(text, opts)
  const wavPath = opts.output.replace(/\.mp3$/i, '_omni.wav')
  await fs.writeFile(wavPath, wav)
  try {
    await ffmpegToMp3(wavPath, opts.output)
  } finally {
    await fs.rm(wavPath, { force: true })
  }
  logger.info(`OmniVoice synthesized: ${path.basename(opts.output)} (${opts.ref}, ${text.length} chars)`)
  return opts.output
}

// ===== OmniVoice 声音设计（Voice Design）：文字描述造声，保存时固化为参考音色 =====

/** 设计音色的统一前缀：作为音色名参与全链路路由（同 custom- 之于 XTTS） */
export const OMNI_VOICE_PREFIX = 'omni-'

export function isOmniDesignedVoice(voice: string): boolean {
  return typeof voice === 'string' && voice.startsWith(OMNI_VOICE_PREFIX)
}

export interface OmniDesign {
  /** 设计名（用户可见） */
  name: string
  /** 参考音色名（omni-<name>，即 voices/ 中声纹 wav 的名字） */
  ref: string
  /** 声音描述（性别/年龄/音调等，逗号分隔，支持中文） */
  instruct: string
  /** 性别：female / male（供 AI 按角色性别分配） */
  gender?: string
  createdAt?: number
}

async function omniJson<T>(
  fixedPath: '/designs' | '/designs/sample' | '/designs/delete',
  body: unknown
): Promise<T> {
  const resp = await axios.post(serviceUrl('omnivoice', fixedPath), body, { timeout: 0 })
  return resp.data as T
}

/** 已保存的设计音色列表 */
export async function listOmniDesigns(): Promise<OmniDesign[]> {
  try {
    const resp = await fetch(serviceUrl('omnivoice', '/designs'), {
      signal: AbortSignal.timeout(5000),
    })
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = (await resp.json()) as { designs?: OmniDesign[] }
    return data.designs || []
  } catch (error) {
    logger.warn(`List OmniVoice designs failed: ${(error as Error).message}`)
    return []
  }
}

/**
 * 保存设计音色：用描述生成固定声纹样本（约 9 秒）并存为参考音频 omni-<name>.wav，
 * 之后与普通参考音色一样按克隆合成，保证全书同一角色声音一致。同名保存=重摇声纹。
 */
export async function saveOmniDesign(payload: {
  name: string
  instruct: string
  gender?: string
}): Promise<OmniDesign> {
  return enqueueOmniTask(async () => {
    const data = await omniJson<{ design: OmniDesign }>('/designs', payload)
    return data.design
  })
}

export async function deleteOmniDesign(name: string): Promise<void> {
  await omniJson<{ ok: boolean }>('/designs/delete', { name })
}

/** 按描述生成设计试听（不保存；同一描述每次为不同人声） */
export async function previewOmniDesign(payload: {
  instruct: string
  text?: string
}): Promise<Buffer> {
  return enqueueOmniTask(async () => {
    const resp = await axios.post(serviceUrl('omnivoice', '/design-preview'), payload, {
      timeout: 0,
      responseType: 'arraybuffer',
      maxBodyLength: Infinity,
    })
    const wav = Buffer.from(resp.data)
    if (!wav.length) throw new Error('omnivoice-server 返回空音频')
    return wav
  })
}

/** 取已保存设计的声纹样本（直接读文件，不推理） */
export async function getOmniDesignSample(name: string): Promise<Buffer> {
  const resp = await axios.post(serviceUrl('omnivoice', '/designs/sample'), { name }, {
    timeout: 30_000,
    responseType: 'arraybuffer',
  })
  const wav = Buffer.from(resp.data)
  if (!wav.length) throw new Error('omnivoice-server 返回空音频')
  return wav
}
