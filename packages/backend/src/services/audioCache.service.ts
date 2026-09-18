import fs from 'fs/promises'
import path from 'path'
import { logger } from '../utils/logger'
import { AUDIO_CACHE_DIR, AUDIO_DIR } from '../config'
import CacheService, { CacheOptions } from './cache.service'

interface AudioData {
  voice: string
  text: string
  rate: string
  pitch: string
  volume: string
  audio: string
  srt: string
}
class AudioCacheService {
  private cache: CacheService

  constructor({ storageType, ttl, storageOptions }: CacheOptions) {
    if (!storageOptions?.cacheDir) throw new Error(`AudioCacheService cacheDir needed!`)
    logger.info(`init AudioCacheService with`, { storageType, ttl, storageOptions })
    this.cache = new CacheService({
      storageType,
      ttl,
      storageOptions,
    })
  }

  async setAudio(str: string, audioData: AudioData): Promise<boolean> {
    return this.cache.set(str, audioData)
  }

  async getAudio(str: string): Promise<AudioData | null> {
    return this.cache.get(str)
  }

  async hasAudio(str: string): Promise<boolean> {
    return this.cache.has(str)
  }

  async cleanExpired(): Promise<void> {
    return this.cache.cleanExpired()
  }
}

const instance = new AudioCacheService({
  storageType: 'file',
  ttl: 365 * 24 * 60 * 60 * 1e3,
  storageOptions: { cacheDir: AUDIO_CACHE_DIR },
})

export default instance

/**
 * 校验缓存记录指向的音频文件是否仍然存在。
 * 缓存条目 TTL 很长，但 audio/ 下的文件可能被移动或清理；
 * 失效的缓存必须当作未命中，否则同文本会永远拿到打不开的音频。
 */
export async function isCacheEntryUsable(entry: { audio?: string } | null): Promise<boolean> {
  const base = decodeURIComponent(String(entry?.audio || '').split('/').pop() || '')
  if (!base) return false
  try {
    await fs.access(path.resolve(AUDIO_DIR, base))
    return true
  } catch {
    logger.warn(`Stale audio cache detected (file missing): ${base}`)
    return false
  }
}
