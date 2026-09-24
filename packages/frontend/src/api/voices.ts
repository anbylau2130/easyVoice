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

/** 音色转换资源：OpenVoice 参考音频 + RVC 模型（角色表「换声源」下拉框数据源） */
export interface VcModelInfo {
  name: string
  hasIndex: boolean
}
export interface VcInfo {
  references: string[]
  models: VcModelInfo[]
}
export const getVcInfo = async (): Promise<VcInfo> => {
  const response = await api.get<{
    success: boolean
    code: number
    message?: string
    data: VcInfo
  }>('/vc-info')
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '获取音色转换资源失败')
  }
  return response.data.data || { references: [], models: [] }
}

// ===== OmniVoice 音色设计（Voice Design）=====

export interface OmniDesign {
  /** 设计名（用户可见） */
  name: string
  /** 参考音色名（omni-<name>，即固化后的声纹） */
  ref: string
  /** 声音描述（性别/年龄/音调等，逗号分隔） */
  instruct: string
  /** 性别：female / male（供 AI 按角色性别分配） */
  gender?: string
  createdAt?: number
}

/** 已保存的设计音色列表 */
export const listOmniDesigns = async (): Promise<OmniDesign[]> => {
  const response = await api.get<{
    success: boolean
    code: number
    message?: string
    data: OmniDesign[]
  }>('/omni-designs')
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '获取设计音色失败')
  }
  return response.data.data || []
}

/**
 * 保存设计音色。携带 audio（Blob：试听满意的声音纹理，或用户上传的参考音频，任意常见
 * 格式，后端规一化为 24kHz 单声道并裁到 10 秒）；未携带时按 instruct 现场生成新声纹（重摇）。
 * CPU 生成较慢，不设超时等待完成
 */
export const createOmniDesign = async (payload: {
  name: string
  instruct: string
  gender?: string
  audio?: Blob
}): Promise<OmniDesign> => {
  let audioBase64: string | undefined
  if (payload.audio?.size) {
    audioBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
      reader.onerror = () => reject(new Error('读取音频失败'))
      reader.readAsDataURL(payload.audio!)
    })
  }
  const response = await api.post<{
    success: boolean
    code: number
    message?: string
    data: OmniDesign
  }>(
    '/omni-designs',
    {
      name: payload.name,
      instruct: payload.instruct,
      gender: payload.gender,
      audioBase64,
    },
    { timeout: 0, maxBodyLength: Infinity }
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '保存设计音色失败')
  }
  return response.data.data
}

export const deleteOmniDesign = async (name: string): Promise<void> => {
  const response = await api.post<{ success: boolean; code: number; message?: string }>(
    '/omni-designs/delete',
    { name },
    { timeout: 30000 }
  )
  if (response.data?.code !== 200) {
    throw new Error(response.data?.message || '删除设计音色失败')
  }
}

/** 按描述试听（不保存；同一描述每次为不同人声。CPU 较慢，不设超时） */
export const previewOmniDesign = async (payload: { instruct: string; text?: string }): Promise<Blob> => {
  const response = await api.post<Blob>('/omni-designs/preview', payload, {
    responseType: 'blob',
    timeout: 0,
  })
  return response.data
}

/** 试听效果：按声纹现场合成一段试听语音（首次较慢，结果缓存后秒回） */
export const fetchOmniDesignSample = async (name: string): Promise<Blob> => {
  const response = await api.post<Blob>('/omni-designs/sample', { name }, {
    responseType: 'blob',
    timeout: 0,
  })
  return response.data
}
