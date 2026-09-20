import { AxiosError } from 'axios'
import { MODEL_NAME, OPENAI_BASE_URL, OPENAI_API_KEY } from '../config'
import { logger } from './logger'
import { fetcher } from './request'

// 配置接口定义
interface OpenAIConfig {
  baseURL?: string
  model?: string
  timeout: number
  apiKey?: string
}

/**
 * 创建 OpenAI 客户端实例
 * @returns OpenAI 工具函数集合
 */
export function createOpenAIClient() {
  // 默认配置
  let currentConfig: OpenAIConfig = {
    baseURL: OPENAI_BASE_URL,
    model: MODEL_NAME,
    // 推理型模型（如 glm-5.3）处理大 prompt 时耗时明显更长，60s 会频繁超时
    timeout: 300000,
    apiKey: OPENAI_API_KEY,
  }
  logger.debug(`init openai with: `, {
    ...currentConfig,
    apiKey: currentConfig?.apiKey ? currentConfig?.apiKey?.slice(0, 10) + '***' : undefined,
  })
  // 设置 headers
  const getHeaders = () => ({
    Authorization: `Bearer ${currentConfig.apiKey || OPENAI_API_KEY}`,
    'Content-Type': 'application/json',
  })

  /**
   * 创建 Chat Completion
   * @param request 请求参数
   * @param customConfig 自定义配置，可覆盖默认配置
   */
  async function createChatCompletion(
    request: ChatCompletionRequest,
    customConfig?: Partial<OpenAIConfig>
  ): Promise<ChatCompletionResponse> {
    try {
      const mergedConfig = {
        ...currentConfig,
        ...customConfig,
      }
      // 兜底：全局配置可能被意外置空（undefined），回落到环境变量初始值
      const baseURL = mergedConfig.baseURL || OPENAI_BASE_URL
      const model = mergedConfig.model || MODEL_NAME

      const response = await fetcher.post<ChatCompletionResponse>(
        `${baseURL}${baseURL?.endsWith('/') ? '' : '/'}chat/completions`,
        {
          model: request.model || model,
          temperature: request.temperature ?? 1.0,
          max_tokens: request.max_tokens,
          top_p: request.top_p ?? 1.0,
          stream: request.stream ?? false,
          ...request,
        },
        {
          headers: getHeaders(),
          timeout: mergedConfig.timeout,
        }
      )

      return response.data
    } catch (error) {
      console.log(error)
      if (error instanceof AxiosError) {
        console.log(`createChatCompletion`, error.response?.data?.error)
      }
      throw new Error(
        `Chat completion request failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /**
   * 获取可用模型列表
   */
  async function getModels(): Promise<{ data: { id: string }[] }> {
    try {
      const response = await fetcher.get<{ data: { id: string }[] }>(
        `${currentConfig.baseURL}/models`,
        {},
        {
          headers: getHeaders(),
          timeout: currentConfig.timeout,
        }
      )
      return response.data
    } catch (error) {
      throw new Error(
        `Get models failed: ${error instanceof Error ? error.message : String(error)}`
      )
    }
  }

  /** 当前生效的模型名（供调用方按模型特性调整请求参数，如 GLM 关闭思考提速） */
  function getModel(): string {
    return currentConfig.model || MODEL_NAME || ''
  }

  /**
   * 简单提取类任务（人物普查/角色分配）的提速参数：
   * GLM 系列推理模型默认先"思考"，这类结构化提取不需要，关闭后单次调用耗时大幅下降。
   */
  function fastExtractFields(model: string): { thinking?: { type: 'disabled' } } {
    return /glm/i.test(model) ? { thinking: { type: 'disabled' } } : {}
  }

  /**
   * 动态更新配置
   * @param newConfig 新的配置参数
   */
  function config(newConfig: Partial<OpenAIConfig>) {
    currentConfig = {
      ...currentConfig,
      ...newConfig,
    }
    logger.debug(`openai currentConfig:`, currentConfig)
  }

  return {
    createChatCompletion,
    getModels,
    getModel,
    fastExtractFields,
    config,
  }
}

export const openai = createOpenAIClient()
