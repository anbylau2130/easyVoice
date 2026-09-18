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
