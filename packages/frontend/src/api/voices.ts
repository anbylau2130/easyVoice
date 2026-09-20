import axios from 'axios'

const DEV_URL = 'http://localhost:3000/api/v1/voices'
const PROD_URL = (import.meta.env.VITE_API_URL || '/api/v1/tts').replace(/\/tts$/, '') + '/voices'
const baseURL = import.meta.env.MODE === 'development' ? DEV_URL : PROD_URL

const api = axios.create({ baseURL, timeout: 120000 })

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const backendMessage =
      error?.response?.data?.message || error?.response?.data?.errors?.[0]?.message
    return Promise.reject(new Error(backendMessage || error?.message || '请求失败'))
  }
)

export interface CustomVoice {
  id: string
  name: string
  voice: string
  file: string
  createdAt: string
}

export const listCustomVoices = async (): Promise<CustomVoice[]> => {
  const response = await api.get<{ success: boolean; code: number; data: CustomVoice[] }>('/custom')
  return response.data?.data || []
}

export const uploadCustomVoice = async (
  name: string,
  contentBase64: string,
  ext: string
): Promise<CustomVoice> => {
  const response = await api.post<{
    success: boolean
    code: number
    message?: string
    data: CustomVoice
  }>('/custom', { name, contentBase64, ext })
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '上传失败')
  }
  return response.data.data
}

export const deleteCustomVoice = async (id: string) => {
  const response = await api.delete<{ success: boolean; code: number; message?: string }>(
    `/custom/${id}`
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '删除失败')
  }
  return response.data?.message
}

/** 克隆音色试听：XTTS 纯 CPU 推理较慢，返回音频 Blob */
export const previewCustomVoice = async (id: string): Promise<Blob> => {
  const response = await api.post<Blob>(`/custom/${id}/preview`, {}, { responseType: 'blob' })
  return response.data
}

// ===== 自定义 Edge 音色预设 =====

export interface VoicePreset {
  id: string
  name: string
  /** 基础 Edge 音色（voice.json 中的 Name） */
  voice: string
  rate?: string
  pitch?: string
  volume?: string
  style?: string
  gender?: string
  createdAt: string
}

export interface VoicePresetPayload {
  name: string
  voice: string
  rate?: string
  pitch?: string
  volume?: string
  style?: string
  gender?: string
}

export const listVoicePresets = async (): Promise<VoicePreset[]> => {
  const response = await api.get<{ success: boolean; code: number; data: VoicePreset[] }>(
    '/presets'
  )
  return response.data?.data || []
}

export const saveVoicePreset = async (payload: VoicePresetPayload): Promise<VoicePreset> => {
  const response = await api.post<{
    success: boolean
    code: number
    message?: string
    data: VoicePreset
  }>('/presets', payload)
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '保存失败')
  }
  return response.data.data
}

export const deleteVoicePreset = async (id: string) => {
  const response = await api.delete<{ success: boolean; code: number; message?: string }>(
    `/presets/${id}`
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '删除失败')
  }
  return response.data?.message
}

/** 预设试听：返回音频 Blob（axios 需要显式声明泛型才能拿到 Blob 类型） */
export const previewPresetVoice = async (payload: VoicePresetPayload): Promise<Blob> => {
  const response = await api.post<Blob>('/presets/preview', payload, { responseType: 'blob' })
  return response.data
}
