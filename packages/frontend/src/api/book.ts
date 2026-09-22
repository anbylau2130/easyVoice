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
  /** 全书对白句数（权重：列表排序依据） */
  dialog?: number
  /** 该角色在书中的其他称呼（与 character 指同一人） */
  aliases?: string[]
  /** 换声源：openvoice=参考音频名 / rvc=模型名（openvoice/rvc 引擎下生效） */
  vcRef?: string
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
    /** 配音引擎（旧书可能缺省，视作 edge） */
    voiceEngine?: VoiceEngine
  }
  chapters: BookChapter[]
  createdAt: string
  updatedAt: string
  /** AI 模式：全书统一的角色-音色映射 */
  characterVoices?: CharacterVoice[]
  /** AI 模式：正在规划角色音色 */
  planning?: boolean
  /** AI 模式：规划进度描述（如"正在通读第 12/60 章"） */
  planningDetail?: string
  /** AI 模式：本轮规划开始时间（前端据此显示已用时） */
  planningStartedAt?: string
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
  /** 该书是否正在规划角色音色 */
  planning?: boolean
  /** 书的输出目录（绝对路径） */
  dir: string
  createdAt: string
  updatedAt: string
}

export type VoiceEngine = 'edge' | 'clone' | 'openvoice' | 'rvc'

export interface BookParamsPayload {
  voice: string
  rate: string
  pitch: string
  volume: string
  useLLM: boolean
  /** 配音引擎：edge=纯 Edge 预设 / clone=XTTS 声音克隆 / openvoice=Edge+OpenVoice 换声 / rvc=Edge+RVC 换声 */
  voiceEngine?: VoiceEngine
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

/** 单章重新生成：覆盖该章节现有音频与字幕（已完成/失败章节均可） */
export const regenerateChapter = async (id: string, index: number) => {
  const response = await api.post<{ success: boolean; code: number; message?: string }>(
    `/${id}/chapters/${index}/regenerate`
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '重新生成失败')
  }
  return response.data?.message
}

/** 全文重新生成：全部章节重新合成并覆盖。fresh=true 忽略音频缓存强制全新合成 */
export const regenerateAll = async (id: string, fresh: boolean) => {
  const response = await api.post<{ success: boolean; code: number; message?: string }>(
    `/${id}/regenerateAll`,
    { fresh }
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '重新生成失败')
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

/** 更新章节选择：indexes 中的章节（重新）纳入生成，其余未开始章节设为跳过 */
export const updateChapterSelection = async (id: string, indexes: number[]) => {
  const response = await api.post<{
    success: boolean
    code: number
    message?: string
    data: BookDetail
  }>(`/${id}/selection`, { indexes })
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '保存章节选择失败')
  }
  return response.data.data
}

export const chapterAudioUrl = (id: string, index: number) =>
  `${api.defaults.baseURL}/${id}/chapter/${index}/audio`
export const chapterSrtUrl = (id: string, index: number) =>
  `${api.defaults.baseURL}/${id}/chapter/${index}/srt`

export const planVoices = async (id: string, mode?: 'match' | 'generate') => {
  const response = await api.post<{ success: boolean; code: number; message?: string }>(
    `/${id}/planVoices`,
    mode ? { mode } : {}
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '规划失败')
  }
  return response.data?.message
}

/** 停止规划：当前章节读完即生效 */
export const stopPlanVoices = async (id: string) => {
  const response = await api.post<{ success: boolean; code: number; message?: string }>(
    `/${id}/planVoices/stop`
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '停止失败')
  }
  return response.data?.message
}

export const saveCharacterVoices = async (
  id: string,
  characters: { character: string; voice: string; vcRef?: string }[]
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

export const characterPreviewUrl = (id: string, character: string, download?: boolean) =>
  `${api.defaults.baseURL}/${id}/character/preview?character=${encodeURIComponent(character)}${download ? '&download=1' : ''}`
