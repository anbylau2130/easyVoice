// tests/voicePreset.test.ts
import { createHash } from 'crypto'
import {
  saveVoicePreset,
  getVoicePreset,
  listVoicePresets,
  deleteVoicePreset,
  isPresetVoice,
} from '../src/services/voicePreset.service'

const TEST_NAME = '__jest__测试预设'

afterAll(async () => {
  // 兜底清理测试数据（写的是真实 data/voice-presets.json）
  const slug = TEST_NAME.replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fff-]/g, '').slice(0, 30)
  const id = `edge-${createHash('sha256').update(slug).digest('hex').slice(0, 8)}`
  await deleteVoicePreset(id).catch(() => {})
})

describe('voicePreset.service', () => {
  test('isPresetVoice only matches edge- prefix', () => {
    expect(isPresetVoice('edge-1a2b3c4d')).toBe(true)
    expect(isPresetVoice('custom-1a2b3c4d')).toBe(false)
    expect(isPresetVoice('zh-CN-XiaoyiNeural')).toBe(false)
  })

  test('rejects missing name / voice and bad param formats', async () => {
    await expect(saveVoicePreset({ name: '', voice: 'zh-CN-XiaoyiNeural' })).rejects.toThrow(
      '请填写音色名称'
    )
    await expect(saveVoicePreset({ name: 'x', voice: '' })).rejects.toThrow('请选择基础音色')
    await expect(
      saveVoicePreset({ name: 'x', voice: 'zh-CN-XiaoyiNeural', rate: 'fast' })
    ).rejects.toThrow('语速格式')
    await expect(
      saveVoicePreset({ name: 'x', voice: 'zh-CN-XiaoyiNeural', pitch: '+20%' })
    ).rejects.toThrow('音调格式')
    await expect(
      saveVoicePreset({ name: 'x', voice: 'zh-CN-XiaoyiNeural', style: 'kungfu' })
    ).rejects.toThrow('情感风格')
  })

  test('saves with deterministic id and resolves via getVoicePreset', async () => {
    const entry = await saveVoicePreset({
      name: TEST_NAME,
      voice: 'zh-CN-YunxiNeural',
      rate: '+10%',
      pitch: '-10Hz',
      style: 'narration-relaxed',
      gender: 'Male',
    })
    expect(entry.id).toMatch(/^edge-[0-9a-f]{8}$/)
    expect(entry.voice).toBe('zh-CN-YunxiNeural')
    expect(entry.rate).toBe('+10%')

    // 同名再保存 → 同 ID（确定性哈希），createdAt 保留
    const again = await saveVoicePreset({ name: TEST_NAME, voice: 'zh-CN-YunxiNeural' })
    expect(again.id).toBe(entry.id)
    expect(again.createdAt).toBe(entry.createdAt)
    expect(again.rate).toBeUndefined()

    const resolved = await getVoicePreset(entry.id)
    expect(resolved?.name).toBe(TEST_NAME)
    const listed = await listVoicePresets()
    expect(listed.some((p) => p.id === entry.id)).toBe(true)

    await deleteVoicePreset(entry.id)
    expect(await getVoicePreset(entry.id)).toBeNull()
  })

  test('deleting an unknown preset throws', async () => {
    await expect(deleteVoicePreset('edge-00000000')).rejects.toThrow('未找到')
  })
})
