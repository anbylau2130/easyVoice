import fs from 'fs/promises'
import crypto from 'crypto'
import path from 'path'
import { AUDIO_DIR } from '../config'
import { logger } from '../utils/logger'

/**
 * 角色试听音频缓存：同角色同参数（音色/换声源/文本）复用已生成的音频文件。
 * 目录位于 AUDIO_DIR/.cache/preview（随部署映射在宿主机 docker-data/audio/.cache/preview）。
 * 缓存键为调用方传入参数的 sha256 摘要（32 位十六进制），文件名固定为 "<key>.<ext>"；
 * 读写前均校验键格式，杜绝路径穿越。
 */

const PREVIEW_CACHE_DIR = path.resolve(AUDIO_DIR, '.cache', 'preview')
const KEY_PATTERN = /^[a-f0-9]{32}$/
/** 缓存文件数上限，超出时清理最旧的文件 */
const PREVIEW_CACHE_LIMIT = 200

export function buildPreviewCacheKey(parts: Record<string, unknown>): string {
  return crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}

function previewFile(key: string, ext: string): string | null {
  if (!KEY_PATTERN.test(key) || !['mp3', 'wav'].includes(ext)) return null
  return path.join(PREVIEW_CACHE_DIR, `${key}.${ext}`)
}

export async function readPreviewCache(key: string, ext: string): Promise<Buffer | null> {
  const file = previewFile(key, ext)
  if (!file) return null
  return fs.readFile(file).catch(() => null)
}

async function trimPreviewCache(dir: string): Promise<void> {
  const files = (await fs.readdir(dir))
    .filter((f) => f.endsWith('.mp3') || f.endsWith('.wav'))
    .map((f) => path.join(dir, f))
  if (files.length <= PREVIEW_CACHE_LIMIT) return
  const stats = await Promise.all(files.map(async (f) => ({ f, m: (await fs.stat(f)).mtimeMs })))
  const excess = stats.sort((a, b) => a.m - b.m).slice(0, files.length - PREVIEW_CACHE_LIMIT + 50)
  await Promise.all(excess.map(({ f }) => fs.rm(f, { force: true })))
  logger.info(`Preview cache trimmed: removed ${excess.length} oldest file(s)`)
}

/** 写入试听缓存并清理超限旧文件；键非法时静默跳过（不缓存仅影响性能，不影响功能） */
export async function writePreviewCache(
  key: string,
  ext: string,
  buffer: Buffer
): Promise<void> {
  const file = previewFile(key, ext)
  if (!file) return
  await fs.mkdir(PREVIEW_CACHE_DIR, { recursive: true })
  await trimPreviewCache(PREVIEW_CACHE_DIR)
  await fs.writeFile(file, buffer)
}
