import fs from 'fs/promises'
import path from 'path'
import { OPENAI_API_KEY, OPENAI_BASE_URL, MODEL_NAME } from '../config'
import { openai } from '../utils/openai'
import { logger } from '../utils/logger'

/**
 * 服务端 LLM 配置：页面上保存后立即生效（openai.config），并落盘持久化，
 * 重启后自动恢复，无需再编辑 .env。
 * 注意：baseUrl 支持本机地址（如 Ollama/LM Studio 的 localhost 端口），
 * 这是自部署场景的合法用法，因此不做内网地址拦截，仅限制 http/https 协议。
 */

const DATA_DIR = path.resolve(__dirname, '../../data')
const SETTINGS_FILE = path.join(DATA_DIR, 'llm-settings.json')

export interface LlmSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
}

async function readSettings(): Promise<LlmSettings> {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf-8'))
  } catch {
    return {}
  }
}

function apply(settings: LlmSettings): void {
  const patch: Partial<{ baseURL: string; apiKey: string; model: string }> = {}
  if (settings.baseUrl !== undefined) patch.baseURL = settings.baseUrl
  if (settings.apiKey !== undefined) patch.apiKey = settings.apiKey
  if (settings.model !== undefined) patch.model = settings.model
  if (Object.keys(patch).length) {
    openai.config(patch)
    logger.info('LLM settings applied', {
      baseUrl: patch.baseURL || OPENAI_BASE_URL,
      model: patch.model || MODEL_NAME,
      apiKeyUpdated: patch.apiKey !== undefined,
    })
  }
}

/** 服务启动时调用：恢复页面上保存过的配置（优先于 .env） */
export async function initLlmSettings(): Promise<void> {
  const stored = await readSettings()
  apply(stored)
}

/** 供页面展示：密钥永不回传，只返回是否已配置 */
export async function getLlmSettings(): Promise<{
  baseUrl: string
  model: string
  apiKeyConfigured: boolean
}> {
  const stored = await readSettings()
  return {
    baseUrl: stored.baseUrl || OPENAI_BASE_URL || '',
    model: stored.model || MODEL_NAME || '',
    apiKeyConfigured: !!(stored.apiKey || OPENAI_API_KEY),
  }
}

/** 保存并立即生效；空字符串表示清除该项（回落到 .env 兜底） */
export async function saveLlmSettings(patch: LlmSettings): Promise<void> {
  const current = await readSettings()
  const next: LlmSettings = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined || value === '') {
      delete next[key as keyof LlmSettings]
    } else {
      next[key as keyof LlmSettings] = value
    }
  }
  await fs.mkdir(DATA_DIR, { recursive: true })
  await fs.writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2), 'utf-8')
  // 立即生效：被清除的 key 显式传 undefined（openai.ts 有 env 兜底），否则内存旧值会继续生效
  openai.config({ baseURL: next.baseUrl, apiKey: next.apiKey, model: next.model })
}
