import fs from 'fs/promises'
import path from 'node:path'
import ffmpeg from '../utils/ffmpeg'
import { logger } from '../utils/logger'

/**
 * 音色转换（Voice Conversion）客户端：调用独立转换服务完成频谱级换声。
 * 管线：edge-tts 合成基础音频 → 本服务调用转换服务 → 得到目标音色音频。
 * 两种引擎各自独立部署：
 *  - openvoice → vc-server（OpenVoice2 零样本换声，ref 为参考音频名，相似度中等，启动即用）
 *  - rvc → rvc-server（RVC v2 模型换声，ref 为已训练模型名，相似度更高、CPU 推理更快）
 */

// 两个转换服务的地址均为服务端配置的内网地址（docker 网络/本机回环），
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
const VC_TIMEOUT_MS = 120_000

/** 在指定服务的基址上拼接固定路径（路径为代码内常量，不拼接用户输入） */
function serviceUrl(engine: VcEngine, fixedPath: '/references' | '/models' | '/convert' | '/health'): string {
  const base = engine === 'rvc' ? RVC_BASE : VC_BASE
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
