import { Request, Response, NextFunction } from 'express'
import fs from 'fs/promises'
import { PassThrough, Readable } from 'stream'
import { z } from 'zod'
import { logger } from '../utils/logger'
import { safeRunWithRetry } from '../utils'
import { parseBookFile } from '../services/book/chapter.service'
import {
  createBook,
  deleteBook,
  listBooks,
  loadBook,
  pauseBook,
  resumeBook,
  retryFailedChapters,
  chapterFilePath,
  bookOutputDir,
  planBookVoices,
  stopPlanVoices,
  saveCharacterVoices,
  updateChapterSelection,
} from '../services/book/book.service'
import { generateSingleVoiceBuffer } from '../services/edge-tts.service'

// base64 膨胀 4/3，需低于全局 express.json 的 20mb 上限
const MAX_BOOK_FILE_BYTES = 14 * 1024 * 1024
const MAX_CHAPTER_CHARS = 500_000

const parseBookSchema = z.object({
  filename: z.string().trim().min(1),
  contentBase64: z.string().min(1),
})

const bookChapterSchema = z.object({
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1),
  include: z.boolean().default(true),
})

const bookParamsSchema = z.object({
  voice: z.string().trim().min(1),
  rate: z.string().trim().default('+0%'),
  pitch: z.string().trim().default('+0Hz'),
  volume: z.string().trim().default('+0%'),
  useLLM: z.boolean().default(false),
})

const createBookSchema = z.object({
  title: z.string().trim().min(1).max(200),
  chapters: z.array(bookChapterSchema).min(1).max(2000),
  params: bookParamsSchema,
  autostart: z.boolean().default(true),
})

function zodMessage(error: z.ZodError): string {
  return error.issues[0]?.message || '参数格式错误'
}

export async function parseBookHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = parseBookSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ success: false, code: 400, message: zodMessage(parsed.error) })
      return
    }
    const buffer = Buffer.from(parsed.data.contentBase64, 'base64')
    if (!buffer.length || buffer.length > MAX_BOOK_FILE_BYTES) {
      res.status(400).json({
        success: false,
        code: 400,
        message: `文件大小需在 1 字节到 ${Math.floor(MAX_BOOK_FILE_BYTES / 1024 / 1024)}MB 之间`,
      })
      return
    }
    const result = parseBookFile(parsed.data.filename, buffer)
    res.json({ success: true, code: 200, data: result })
  } catch (error) {
    logger.warn(`parseBook failed: ${(error as Error).message}`)
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

export async function createBookHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const parsed = createBookSchema.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ success: false, code: 400, message: zodMessage(parsed.error) })
      return
    }
    const tooLong = parsed.data.chapters.find((c) => c.content.length > MAX_CHAPTER_CHARS)
    if (tooLong) {
      res.status(400).json({
        success: false,
        code: 400,
        message: `单章内容过长（${tooLong.title}），请拆分后再试`,
      })
      return
    }
    const book = await createBook(
      {
        title: parsed.data.title,
        chapters: parsed.data.chapters,
        params: parsed.data.params,
        autostart: parsed.data.autostart,
      }
    )
    res.json({ success: true, code: 200, data: { bookId: book.id, book } })
  } catch (error) {
    logger.warn(`createBook failed: ${(error as Error).message}`)
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

export async function listBooksHandler(_req: Request, res: Response, next: NextFunction) {
  try {
    const books = await listBooks()
    res.json({ success: true, code: 200, data: books })
  } catch (error) {
    next(error)
  }
}

export async function getBookHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const book = await loadBook(req.params.id)
    if (!book) {
      res.status(404).json({ success: false, code: 404, message: '有声书不存在' })
      return
    }
    res.json({ success: true, code: 200, data: { ...book, dir: bookOutputDir(req.params.id) } })
  } catch (error) {
    next(error)
  }
}

export async function pauseBookHandler(req: Request, res: Response, next: NextFunction) {
  try {
    const message = await pauseBook(req.params.id)
    res.json({ success: true, code: 200, message })
  } catch (error) {
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

export async function resumeBookHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await resumeBook(req.params.id)
    res.json({ success: true, code: 200, message: '已开始续传' })
  } catch (error) {
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

export async function retryFailedHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await retryFailedChapters(req.params.id)
    res.json({ success: true, code: 200, message: '已开始重试失败章节' })
  } catch (error) {
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

const selectionSchema = z.object({
  indexes: z.array(z.number().int().min(0)).max(5000),
})

export async function updateSelectionHandler(req: Request, res: Response) {
  try {
    const parsed = selectionSchema.safeParse(req.body ?? {})
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 400,
        message: parsed.error.issues[0]?.message || '参数格式错误',
      })
      return
    }
    const book = await updateChapterSelection(req.params.id, parsed.data.indexes)
    res.json({ success: true, code: 200, data: book })
  } catch (error) {
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

export async function deleteBookHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await deleteBook(req.params.id)
    res.json({ success: true, code: 200, message: '有声书已删除' })
  } catch (error) {
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

async function sendChapterFile(
  req: Request,
  res: Response,
  ext: string,
  contentType: string
): Promise<void> {
  const id = req.params.id
  const index = Number.parseInt(req.params.index, 10)
  if (!/^[\w-]+$/.test(id) || !Number.isInteger(index) || index < 0) {
    res.status(400).json({ success: false, code: 400, message: '参数无效' })
    return
  }
  const filePath = chapterFilePath(id, index, ext)
  try {
    await fs.access(filePath)
  } catch {
    res.status(404).json({ success: false, code: 404, message: '章节文件尚未生成' })
    return
  }
  res.setHeader('Content-Type', contentType)
  res.sendFile(filePath, {
    headers: { 'Content-Disposition': `attachment; filename="chapter${index}${ext}"` },
  })
}

export async function chapterAudioHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await sendChapterFile(req, res, '.mp3', 'audio/mpeg')
  } catch (error) {
    next(error)
  }
}

export async function chapterSrtHandler(req: Request, res: Response, next: NextFunction) {
  try {
    await sendChapterFile(req, res, '.srt', 'application/x-subrip; charset=utf-8')
  } catch (error) {
    next(error)
  }
}

export async function planVoicesHandler(req: Request, res: Response, next: NextFunction) {
  try {
    // 分配方式：match=按性格匹配已配置音色（默认）；generate=AI 为每个角色生成专属音色
    const mode = req.body?.mode === 'generate' ? 'generate' : 'match'
    await planBookVoices(req.params.id, mode)
    res.json({ success: true, code: 200, message: '已开始规划角色音色' })
  } catch (error) {
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

export async function stopPlanVoicesHandler(req: Request, res: Response) {
  try {
    const accepted = stopPlanVoices(req.params.id)
    res.json({
      success: true,
      code: 200,
      message: accepted
        ? '正在停止规划，当前章节读完即生效'
        : '规划未在进行（可能因服务重启中断），已清理遗留的规划状态',
    })
  } catch (error) {
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

const characterVoiceEditSchema = z.object({
  character: z.string().trim().min(1),
  voice: z.string().trim().min(1),
})

export async function saveCharacterVoicesHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const parsed = z
      .object({ characters: z.array(characterVoiceEditSchema).min(1).max(500) })
      .safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({
        success: false,
        code: 400,
        message: parsed.error.issues[0]?.message || '参数格式错误',
      })
      return
    }
    await saveCharacterVoices(req.params.id, parsed.data.characters)
    const book = await loadBook(req.params.id)
    res.json({
      success: true,
      code: 200,
      message: '角色音色已更新',
      data: book?.characterVoices,
    })
  } catch (error) {
    res.status(400).json({ success: false, code: 400, message: (error as Error).message })
  }
}

/** 试听角色音色：用该角色分配的音色朗读其性格描述 */
export async function previewCharacterHandler(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    const id = req.params.id
    const character = String(req.query.character || '').trim()
    if (!/^[\w-]+$/.test(id)) {
      res.status(400).json({ success: false, code: 400, message: '参数无效' })
      return
    }
    const book = await loadBook(id)
    if (!book) {
      res.status(404).json({ success: false, code: 404, message: '有声书不存在' })
      return
    }
    const entry = book.characterVoices?.find((c) => c.character === character)
    if (!entry) {
      res.status(404).json({ success: false, code: 404, message: '未找到该角色的音色' })
      return
    }
    const description = (entry.description || '').replace(/\s+/g, ' ').trim()
    const text = `我是${entry.character}。${description || '这是我配音试听。'}`
    // buffer 模式合成：短文本一次成形，风格被微软端拒绝时后端自动去风格重试
    const buffer = await generateSingleVoiceBuffer({
      text,
      voice: entry.voice,
      rate: '+0%',
      pitch: '+0Hz',
      volume: '+0%',
    })
    // 音频二进制经流式管道写出（Content-Type: audio/mpeg，非 HTML 输出）
    res.setHeader('Content-Type', 'audio/mpeg')
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Content-Length', String(buffer.length))
    const audioStream = new PassThrough()
    audioStream.end(buffer)
    audioStream.pipe(res)
  } catch (error) {
    logger.warn(`Character preview failed: ${(error as Error).message}`)
    if (!res.headersSent) {
      res.status(500).json({ success: false, code: 500, message: (error as Error).message })
    } else {
      res.destroy(error as Error)
    }
  }
}
