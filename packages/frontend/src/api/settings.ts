import axios from 'axios'

const DEV_URL = 'http://localhost:3000/api/v1/settings'
const PROD_URL = (import.meta.env.VITE_API_URL || '/api/v1/tts')
  .replace(/\/tts$/, '')
  .replace(/\/book$/, '')
  .concat('/settings')
const baseURL = import.meta.env.MODE === 'development' ? DEV_URL : PROD_URL

const api = axios.create({ baseURL, timeout: 30000 })

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const backendMessage =
      error?.response?.data?.message || error?.response?.data?.errors?.[0]?.message
    return Promise.reject(new Error(backendMessage || error?.message || '请求失败'))
  }
)

export interface LlmSettingsView {
  baseUrl: string
  model: string
  apiKeyConfigured: boolean
}

export interface LlmSettingsPayload {
  baseUrl?: string
  apiKey?: string
  model?: string
}

export const getLlmSettings = async (): Promise<LlmSettingsView> => {
  const response = await api.get<{ success: boolean; code: number; data: LlmSettingsView }>(
    '/llm'
  )
  return response.data.data
}

export const saveLlmSettings = async (payload: LlmSettingsPayload): Promise<LlmSettingsView> => {
  const response = await api.post<{
    success: boolean
    code: number
    message?: string
    data: LlmSettingsView
  }>('/llm', payload)
  return response.data.data
}

export interface CloneSettings {
  baseUrl: string
  language: string
  /** 已废弃：当前克隆服务（xtts-api-server）不支持 URL 拉取参考音频，仅保留存储兼容 */
  wavUrlPrefix?: string
}

export interface CloneTestResult {
  ok: boolean
  message: string
  latencyMs: number
}

export const testCloneSettings = async (
  payload: Partial<CloneSettings>
): Promise<CloneTestResult> => {
  const response = await api.post<{ success: boolean; code: number; data: CloneTestResult }>(
    '/clone/test',
    payload ?? {}
  )
  return response.data.data
}

export const getCloneSettings = async (): Promise<CloneSettings> => {
  const response = await api.get<{ success: boolean; code: number; data: CloneSettings }>(
    '/clone'
  )
  return response.data.data
}

export const saveCloneSettings = async (payload: CloneSettings): Promise<CloneSettings> => {
  const response = await api.post<{
    success: boolean
    code: number
    message?: string
    data: CloneSettings
  }>('/clone', payload)
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '保存失败')
  }
  return response.data.data
}
