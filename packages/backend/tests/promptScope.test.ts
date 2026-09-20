// tests/promptScope.test.ts
// AI 选音色范围：中文书仅限 zh-CN（排除粤语 zh-HK / 台湾 zh-TW / 英文），英文书保持 en
import { getPrompt, getCharacterPlanPrompt } from '../src/llm/prompt/generateSegment'

const VOICES = [
  { Name: 'zh-CN-YunxiNeural', Gender: 'Male', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh-CN-XiaoyiNeural', Gender: 'Female', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh-TW-YunJheNeural', Gender: 'Male', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'zh-HK-WanLungNeural', Gender: 'Male', ContentCategories: [], VoicePersonalities: [] },
  { Name: 'en-US-GuyNeural', Gender: 'Male', ContentCategories: [], VoicePersonalities: [] },
]

describe('AI 选音色仅限 zh-CN', () => {
  test('规划 prompt（中文书）只包含 zh-CN 音色', () => {
    const prompt = getCharacterPlanPrompt('zh', VOICES, '小说片段')
    expect(prompt).toContain('zh-CN-YunxiNeural')
    expect(prompt).toContain('zh-CN-XiaoyiNeural')
    expect(prompt).not.toContain('zh-TW-YunJheNeural')
    expect(prompt).not.toContain('zh-HK-WanLungNeural')
    expect(prompt).not.toContain('en-US-GuyNeural')
  })

  test('规划 prompt（英文书）只包含 en 音色', () => {
    const prompt = getCharacterPlanPrompt('eng', VOICES, 'novel excerpt')
    expect(prompt).toContain('en-US-GuyNeural')
    expect(prompt).not.toContain('zh-CN-YunxiNeural')
  })

  test('分段 prompt（中文书）只包含 zh-CN 音色', () => {
    const prompt = getPrompt('zh', VOICES, '待处理内容')
    expect(prompt).toContain('zh-CN-YunxiNeural')
    expect(prompt).not.toContain('zh-TW-YunJheNeural')
    expect(prompt).not.toContain('zh-HK-WanLungNeural')
    expect(prompt).not.toContain('en-US-GuyNeural')
  })

  test('分段 prompt（英文书）只包含 en 音色', () => {
    const prompt = getPrompt('eng', VOICES, 'content')
    expect(prompt).toContain('en-US-GuyNeural')
    expect(prompt).not.toContain('zh-CN-YunxiNeural')
  })
})
