import { Request, Response } from 'express'
import { PassThrough } from 'stream'
import { logger } from '../utils/logger'
import {
  saveCustomVoice,
  listCustomVoices,
  deleteCustomVoice,
} from '../services/customVoice.service'
import {
  listVoicePresets,
  saveVoicePreset,
  deleteVoicePreset,
} from '../services/voicePreset.service'
import { previewPresetVoice } from '../services/edge-tts.service'
import { isCustomVoice, synthesizeCloneVoice } from '../services/clone-tts.service'
import { listOmniReferences, listVcModels, listVcReferences } from '../services/vc.service'
import {
  deleteOmniDesign,
  getOmniDesignSample,
  listOmniDesigns,
  previewOmniDesign,
  saveOmniDesign,
} from '../services/vc.service'
import { z } from 'zod'

/** 设计音色名与服务端保持同一校验：中文/字母/数字/短横线/下划线，长度 1~40 */
const OMNI_DESIGN_NAME_RE = /^[\w\u4e00-\u9fff-]{1,40}$/

/** 已保存的设计音色列表 */
export async function listOmniDesignsHandler(_req: Request, res: Response) {
  try {
    const designs = await listOmniDesigns()
    res.json({ success: true, code: 200, data: designs })
  } catch (error) {
    logger.warn(`listOmniDesigns failed: ${(error as Error).message}`)
    res.status(500).json({ success: false, code: 500, message: (error as Error).message })
  }
}

/** 保存设计音色：按描述生成声纹样本并固化为参考音频（CPU 较慢，等待完成） */
export async function createOmniDesignHandler(req: Request, res: Response) {
  try {
    const parsed = z
      .object({
        name: z.string().trim().regex(OMNI_DESIGN_NAME_RE, '音色名称仅支持中文/字母/数字/短横线/下划线，长度 1~40'),
        instruct: z.string().trim().min(1).max(200),
        gender: z.enum(['female', 'male']).optional(),
      })
      .safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 400,
        message: parsed.error.issues[0]?.message || '参数格式错误',
      })
      return
    }
    const design = await saveOmniDesign(parsed.data)
    res.json({ success: true, code: 200, message: '设计音色已保存', data: design })
  } catch (error) {
    logger.warn(`createOmniDesign failed: ${(error as Error).message}`)
    res.status(500).json({ success: false, code: 500, message: (error as Error).message })
  }
}

export async function deleteOmniDesignHandler(req: Request, res: Response) {
  try {
    const name = String(req.body?.name || '').trim()
    if (!OMNI_DESIGN_NAME_RE.test(name)) {
      res.status(400).json({ success: false, code: 400, message: '音色名称无效' })
      return
    }
    await deleteOmniDesign(name)
    res.json({ success: true, code: 200, message: '设计音色已删除' })
  } catch (error) {
    logger.warn(`deleteOmniDesign failed: ${(error as Error).message}`)
    res.status(500).json({ success: false, code: 500, message: (error as Error).message })
  }
}

/** 按描述试听设计音色（不保存；同一描述每次为不同人声，CPU 较慢） */
export async function previewOmniDesignHandler(req: Request, res: Response) {
  try {
    const parsed = z
      .object({
        instruct: z.string().trim().min(1).max(200),
        text: z.string().trim().max(300).optional(),
      })
      .safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 400,
        message: parsed.error.issues[0]?.message || '参数格式错误',
      })
      return
    }
    const buffer = await previewOmniDesign(parsed.data)
    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Length', String(buffer.length))
    const audioStream = new PassThrough()
    audioStream.end(buffer)
    audioStream.pipe(res)
  } catch (error) {
    logger.warn(`previewOmniDesign failed: ${(error as Error).message}`)
    if (!res.headersSent) {
      res.status(500).json({ success: false, code: 500, message: (error as Error).message })
    } else {
      res.destroy(error as Error)
    }
  }
}

/** 取已保存设计的声纹样本（读文件不推理，试听保存后的固定声音） */
export async function omniDesignSampleHandler(req: Request, res: Response) {
  try {
    const name = String(req.body?.name || '').trim()
    if (!OMNI_DESIGN_NAME_RE.test(name)) {
      res.status(400).json({ success: false, code: 400, message: '音色名称无效' })
      return
    }
    const buffer = await getOmniDesignSample(name)
    res.setHeader('Content-Type', 'audio/wav')
    res.setHeader('Content-Length', String(buffer.length))
    const audioStream = new PassThrough()
    audioStream.end(buffer)
    audioStream.pipe(res)
  } catch (error) {
    logger.warn(`omniDesignSample failed: ${(error as Error).message}`)
    if (!res.headersSent) {
      res.status(500).json({ success: false, code: 500, message: (error as Error).message })
    } else {
      res.destroy(error as Error)
    }
  }
}

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

/** 克隆音色试听：合成一小段固定文本（XTTS 纯 CPU 推理约需 10~40 秒） */
export async function previewCustomVoiceHandler(req: Request, res: Response) {
  try {
    const voice = String(req.params.id || '')
    if (!isCustomVoice(voice)) {
      res.status(400).json({ success: false, code: 400, message: '无效的音色 ID' })
      return
    }
    const buffer = (await synthesizeCloneVoice('你好，这是我克隆音色的试听效果。', voice, {
      mode: 'buffer',
    })) as Buffer
    // 音频二进制经流式管道写出（Content-Type: audio/mpeg，非 HTML 输出）
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Content-Length', String(buffer.length))
    const audioStream = new PassThrough()
    audioStream.end(buffer)
    audioStream.pipe(res)
  } catch (error) {
    logger.warn(`previewCustomVoice failed: ${(error as Error).message}`)
    if (!res.headersSent) {
      res.status(500).json({ success: false, code: 500, message: (error as Error).message })
    } else {
      res.destroy(error as Error)
    }
  }
}

/** 从 voice.json 查基础音色的性别（供 AI 配音性别匹配）；查不到回退到入参 */
function lookupVoiceGender(voice: string, fallback?: string): string | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const list = require('../llm/prompt/voice.json') as { Name: string; Gender?: string }[]
    return list.find((v) => v.Name === voice)?.Gender || fallback || undefined
  } catch {
    return fallback || undefined
  }
}

function presetFormOf(req: Request) {
  const body = req.body ?? {}
  return {
    name: typeof body.name === 'string' ? body.name : '',
    voice: typeof body.voice === 'string' ? body.voice : '',
    rate: typeof body.rate === 'string' ? body.rate : '',
    pitch: typeof body.pitch === 'string' ? body.pitch : '',
    volume: typeof body.volume === 'string' ? body.volume : '',
    style: typeof body.style === 'string' ? body.style : '',
    gender: typeof body.gender === 'string' ? body.gender : '',
  }
}

export async function listVoicePresetsHandler(_req: Request, res: Response) {
  try {
    const data = await listVoicePresets()
    res.json({ success: true, code: 200, data })
  } catch (error) {
    logger.warn(`listVoicePresets failed: ${(error as Error).message}`)
    res.status(500).json({ success: false, code: 500, message: (error as Error).message })
  }
}

export async function saveVoicePresetHandler(req: Request, res: Response) {
  try {
    const form = presetFormOf(req)
    const entry = await saveVoicePreset({
      ...form,
      gender: lookupVoiceGender(form.voice, form.gender),
    })
    res.json({ success: true, code: 200, data: entry })
  } catch (error) {
    logger.warn(`saveVoicePreset failed: ${(error as Error).message}`)
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

export async function deleteVoicePresetHandler(req: Request, res: Response) {
  try {
    await deleteVoicePreset(req.params.id)
    res.json({ success: true, code: 200, message: '自定义音色已删除' })
  } catch (error) {
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

/** 预设试听：用表单当前值合成短音频（不要求先保存） */
export async function previewVoicePresetHandler(req: Request, res: Response) {
  try {
    const form = presetFormOf(req)
    if (!form.voice) {
      res.status(400).json({ success: false, code: 400, message: '请选择基础音色' })
      return
    }
    const buffer = await previewPresetVoice(form)
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Content-Length', String(buffer.length))
    res.send(buffer)
  } catch (error) {
    logger.warn(`previewVoicePreset failed: ${(error as Error).message}`)
    res.status(500).json({ success: false, code: 500, message: (error as Error).message })
  }
}

/** 音色转换资源列表：OpenVoice/OmniVoice 参考音频 + RVC 模型（供角色表换声源下拉框）。
 * OpenVoice 与 OmniVoice 共用 voices/ 目录和命名，合并去重后统一返回 */
export async function getVcInfoHandler(_req: Request, res: Response) {
  try {
    const [references, models, omniReferences] = await Promise.all([
      listVcReferences(),
      listVcModels(),
      listOmniReferences(),
    ])
    const mergedReferences = Array.from(new Set([...references, ...omniReferences]))
    res.json({ success: true, code: 200, data: { references: mergedReferences, models } })
  } catch (error) {
    logger.warn(`getVcInfo failed: ${(error as Error).message}`)
    res.status(500).json({ success: false, code: 500, message: (error as Error).message })
  }
}
