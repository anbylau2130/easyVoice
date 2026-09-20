import fs from 'fs/promises'
import path from 'path'
import { OPENAI_API_KEY, OPENAI_BASE_URL, MODEL_NAME } from '../config'
import { openai } from '../utils/openai'
import { fetcher } from '../utils/request'
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

export interface LlmTestResult {
  ok: boolean
  message: string
  latencyMs: number
}

/**
 * LLM 连通性测试：用表单当前值（不落盘）对 chat/completions 发起一次最小请求，
 * 验证 地址可达 → 密钥有效 → 模型可用。patch 缺省项依次回落：已保存配置 → .env。
 * baseUrl 支持本机/内网自部署地址（合法用法），仅限制 http/https 并拒绝云元数据地址。
 */
export async function testLlmSettings(patch: LlmSettings = {}): Promise<LlmTestResult> {
  const stored = await readSettings()
  const baseUrl = (patch.baseUrl?.trim() || stored.baseUrl || OPENAI_BASE_URL || '').replace(/\/+$/, '')
  const apiKey = patch.apiKey?.trim() || stored.apiKey || OPENAI_API_KEY || ''
  const model = patch.model?.trim() || stored.model || MODEL_NAME || ''
  if (!baseUrl) return { ok: false, message: '请先填写 Base URL', latencyMs: 0 }
  if (!model) return { ok: false, message: '请先填写模型名称', latencyMs: 0 }
  if (!/^https?:\/\//i.test(baseUrl)) {
    return { ok: false, message: 'Base URL 仅支持 http/https 协议', latencyMs: 0 }
  }
  try {
    const url = new URL(baseUrl)
    if (url.hostname === '169.254.169.254') {
      return { ok: false, message: '不允许的地址', latencyMs: 0 }
    }
  } catch {
    return { ok: false, message: 'Base URL 格式无效', latencyMs: 0 }
  }

  const start = Date.now()
  try {
    const response = await fetcher.post(
      `${baseUrl}/chat/completions`,
      {
        model,
        temperature: 0,
        max_tokens: 1024,
        stream: false,
        messages: [{ role: 'user', content: '请原样回复两个字符：OK' }],
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 120_000,
      }
    )
    const latencyMs = Date.now() - start
    const choices = (response.data as { choices?: unknown })?.choices
    if (response.status === 200 && Array.isArray(choices)) {
      return {
        ok: true,
        message: `连接成功（模型 ${model}，${(latencyMs / 1000).toFixed(1)} 秒）`,
        latencyMs,
      }
    }
    return { ok: false, message: `服务响应异常（HTTP ${response.status}）`, latencyMs }
  } catch (err) {
    const ax = err as {
      response?: { status?: number; data?: unknown }
      message?: string
    }
    const data = ax?.response?.data
    let detail: string | undefined
    if (data && typeof data === 'object') {
      const errObj = (data as { error?: { message?: string }; message?: string }) as {
        error?: { message?: string }
        message?: string
      }
      detail = errObj?.error?.message || errObj?.message
    } else if (typeof data === 'string') {
      detail = data.slice(0, 200)
    }
    const status = ax?.response?.status
    const hint =
      status === 401
        ? '（密钥无效或未授权）'
        : status === 404
        ? '（地址或模型不存在）'
        : status === 429
        ? '（触发限速，请稍后再试）'
        : ''
    return {
      ok: false,
      message: `连接失败${hint}：${detail || ax?.message || '未知错误'}`,
      latencyMs: Date.now() - start,
    }
  }
}
