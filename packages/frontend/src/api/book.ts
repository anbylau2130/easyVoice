import axios from 'axios'

const DEV_URL = 'http://localhost:3000/api/v1/book'
const PROD_URL = `${(import.meta.env.VITE_API_URL || '/api/v1/tts').replace(/\/tts$/, '')}/book`
const baseURL = import.meta.env.MODE === 'development' ? DEV_URL : PROD_URL

const api = axios.create({
  baseURL,
  timeout: 120000,
})

// 非 2xx 响应统一转成携带后端具体原因的 Error，避免界面只显示 "status code 400" 这类原始信息
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const backendMessage = error?.response?.data?.message || error?.response?.data?.errors?.[0]?.message
    return Promise.reject(new Error(backendMessage || error?.message || '请求失败'))
  }
)

export interface ParsedChapter {
  title: string
  content: string
  include?: boolean
}

export interface ParseBookResponse {
  title: string
  chapters: ParsedChapter[]
}

export type ChapterStatus = 'pending' | 'processing' | 'done' | 'failed' | 'skipped'

export interface BookChapter {
  index: number
  title: string
  charCount: number
  status: ChapterStatus
  audioFile?: string
  srtFile?: string
  error?: string | null
  /** 片段级进度 0-100（仅 processing 阶段有意义） */
  progress?: number
  /** 本章开始生成的时间（ISO） */
  startedAt?: string
}

export interface CharacterVoice {
  character: string
  voice: string
  /** 角色性别 female/male（规划阶段根据文中角色判定） */
  gender?: string
  description?: string
}

export interface BookDetail {
  id: string
  title: string
  status: 'running' | 'paused' | 'completed'
  params: {
    voice: string
    rate: string
    pitch: string
    volume: string
    useLLM: boolean
  }
  chapters: BookChapter[]
  createdAt: string
  updatedAt: string
  /** AI 模式：全书统一的角色-音色映射 */
  characterVoices?: CharacterVoice[]
  /** AI 模式：正在规划角色音色 */
  planning?: boolean
  /** 书级别提示信息（如规划失败原因） */
  message?: string
}

export interface BookSummary {
  id: string
  title: string
  status: BookDetail['status']
  total: number
  done: number
  failed: number
  /** 书的输出目录（绝对路径） */
  dir: string
  createdAt: string
  updatedAt: string
}

export interface BookParamsPayload {
  voice: string
  rate: string
  pitch: string
  volume: string
  useLLM: boolean
}

export const parseBook = async (filename: string, contentBase64: string) => {
  const response = await api.post<{ success: boolean; code: number; data: ParseBookResponse }>(
    '/parseBook',
    { filename, contentBase64 }
  )
  if (response.data?.code !== 200 || !response.data?.success) {
    throw new Error('解析失败')
  }
  return response.data.data
}

export const createBook = async (payload: {
  title: string
  chapters: ParsedChapter[]
  params: BookParamsPayload
  autostart?: boolean
}) => {
  const response = await api.post<{
    success: boolean
    code: number
    message?: string
    data: { bookId: string; book: BookDetail }
  }>('/create', payload)
  if (response.data?.code !== 200 || !response.data?.success) {
    throw new Error(response.data?.message || '创建有声书失败')
  }
  return response.data.data
}

export const listBooks = async () => {
  const response = await api.get<{ success: boolean; code: number; data: BookSummary[] }>('/list')
  return response.data?.data || []
}

export const getBook = async (id: string) => {
  const response = await api.get<{ success: boolean; code: number; data: BookDetail }>(`/${id}`)
  if (response.data?.code !== 200 || !response.data?.success) {
    throw new Error('获取有声书失败')
  }
  return response.data.data
}

export const pauseBook = async (id: string) => {
  const response = await api.post(`/${id}/pause`)
  return response.data?.message
}

export const resumeBook = async (id: string) => {
  const response = await api.post<{ success: boolean; code: number; message?: string }>(
    `/${id}/resume`
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '续传失败')
  }
  return response.data?.message
}

export const retryFailedChapters = async (id: string) => {
  const response = await api.post<{ success: boolean; code: number; message?: string }>(
    `/${id}/retryFailed`
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '重试失败')
  }
  return response.data?.message
}

export const deleteBook = async (id: string) => {
  const response = await api.delete<{ success: boolean; code: number; message?: string }>(`/${id}`)
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '删除失败')
  }
  return response.data?.message
}

export const chapterAudioUrl = (id: string, index: number) =>
  `${api.defaults.baseURL}/${id}/chapter/${index}/audio`
export const chapterSrtUrl = (id: string, index: number) =>
  `${api.defaults.baseURL}/${id}/chapter/${index}/srt`

export const planVoices = async (id: string) => {
  const response = await api.post<{ success: boolean; code: number; message?: string }>(
    `/${id}/planVoices`
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '规划失败')
  }
  return response.data?.message
}

export const saveCharacterVoices = async (
  id: string,
  characters: { character: string; voice: string }[]
) => {
  const response = await api.post<{
    success: boolean
    code: number
    message?: string
    data: CharacterVoice[]
  }>(`/${id}/characterVoices`, { characters })
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '保存失败')
  }
  return response.data.data
}

export const characterPreviewUrl = (id: string, character: string) =>
  `${api.defaults.baseURL}/${id}/character/preview?character=${encodeURIComponent(character)}`
