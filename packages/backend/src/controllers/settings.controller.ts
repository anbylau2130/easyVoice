import { Request, Response, NextFunction } from 'express'
import { z } from 'zod'
import { logger } from '../utils/logger'
import { getLlmSettings, saveLlmSettings, testLlmSettings } from '../services/settings.service'
import {
  getCloneSettings,
  saveCloneSettings,
  testCloneService,
} from '../services/clone-tts.service'

const llmSettingsSchema = z.object({
  baseUrl: z
    .string()
    .trim()
    .refine((v) => v === '' || /^https?:\/\//i.test(v), {
      message: 'Base URL 仅支持 http/https 地址',
    })
    .optional(),
  apiKey: z.string().trim().optional(),
  model: z.string().trim().optional(),
})

export async function getLlmSettingsHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getLlmSettings()
    res.json({ success: true, code: 200, data })
  } catch (error) {
    next(error)
  }
}

export async function saveLlmSettingsHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = llmSettingsSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 400,
        message: parsed.error.issues[0]?.message || '参数格式错误',
      })
      return
    }
    await saveLlmSettings(parsed.data)
    const data = await getLlmSettings()
    res.json({ success: true, code: 200, message: '配置已保存并立即生效', data })
  } catch (error) {
    logger.warn(`saveLlmSettings failed: ${(error as Error).message}`)
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

const cloneSettingsSchema = z.object({
  baseUrl: z.string().trim().optional(),
  language: z.string().trim().optional(),
  // 克隆服务容器内说话人目录（高级配置，随部署拓扑而定）
  speakersDir: z.string().trim().optional(),
  wavUrlPrefix: z
    .string()
    .trim()
    .refine((v) => v === '' || /^https?:\/\//i.test(v), {
      message: '参考音频地址前缀仅支持 http/https',
    })
    .optional(),
})

export async function getCloneSettingsHandler(
  _req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const data = await getCloneSettings()
    res.json({ success: true, code: 200, data })
  } catch (error) {
    next(error)
  }
}

export async function saveCloneSettingsHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const parsed = cloneSettingsSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 400,
        message: parsed.error.issues[0]?.message || '参数格式错误',
      })
      return
    }
    const data = await saveCloneSettings(parsed.data)
    res.json({ success: true, code: 200, message: '克隆服务配置已保存', data })
  } catch (error) {
    logger.warn(`saveCloneSettings failed: ${(error as Error).message}`)
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

export async function testCloneHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const result = await testCloneService()
    res.json({ success: true, code: 200, data: result })
  } catch (error) {
    logger.warn(`testCloneService failed: ${(error as Error).message}`)
    res.status(500).json({ success: false, code: 500, message: (error as Error).message })
  }
}

/** LLM 连通性测试：用表单当前值发起一次最小真实调用（缺省项回落已保存配置/.env） */
export async function testLlmSettingsHandler(req: Request, res: Response) {
  try {
    const parsed = llmSettingsSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 400,
        message: parsed.error.issues[0]?.message || '参数格式错误',
      })
      return
    }
    const result = await testLlmSettings(parsed.data)
    res.json({ success: true, code: 200, data: result })
  } catch (error) {
    logger.warn(`testLlmSettings failed: ${(error as Error).message}`)
    res.status(500).json({ success: false, code: 500, message: (error as Error).message })
  }
}
