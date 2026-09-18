import { Request, Response } from 'express'
import { logger } from '../utils/logger'
import {
  saveCustomVoice,
  listCustomVoices,
  deleteCustomVoice,
} from '../services/customVoice.service'

// base64 膨胀 4/3，需低于全局 express.json 的 20mb 上限
const MAX_VOICE_BYTES = 14 * 1024 * 1024

export async function listCustomVoicesHandler(_req: Request, res: Response) {
  try {
    const data = await listCustomVoices()
    res.json({ success: true, code: 200, data })
  } catch (error) {
    logger.warn(`listCustomVoices failed: ${(error as Error).message}`)
    res.status(500).json({ success: false, code: 500, message: (error as Error).message })
  }
}

export async function uploadCustomVoiceHandler(req: Request, res: Response) {
  try {
    const { name, contentBase64, ext } = req.body ?? {}
    if (typeof name !== 'string' || !name.trim()) {
      res.status(400).json({ success: false, code: 400, message: '请填写音色名称' })
      return
    }
    if (typeof contentBase64 !== 'string' || !contentBase64) {
      res.status(400).json({ success: false, code: 400, message: '缺少音频内容' })
      return
    }
    const buffer = Buffer.from(contentBase64, 'base64')
    if (!buffer.length || buffer.length > MAX_VOICE_BYTES) {
      res.status(400).json({
        success: false,
        code: 400,
        message: `音频大小需在 1 字节到 ${Math.floor(MAX_VOICE_BYTES / 1024 / 1024)}MB 之间`,
      })
      return
    }
    const entry = await saveCustomVoice(name, buffer, String(ext || '.wav'))
    res.json({ success: true, code: 200, data: entry })
  } catch (error) {
    logger.warn(`uploadCustomVoice failed: ${(error as Error).message}`)
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

export async function deleteCustomVoiceHandler(req: Request, res: Response) {
  try {
    await deleteCustomVoice(req.params.id)
    res.json({ success: true, code: 200, message: '自定义音色已删除' })
  } catch (error) {
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}
