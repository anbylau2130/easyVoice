// tests/tts.test.ts
import { splitText } from '../src/services/text.service'

describe('splitText', () => {
  test('short text returns a single segment', () => {
    const { length, segments } = splitText('你好世界')
    expect(length).toBe(1)
    expect(segments[0]).toBe('你好世界')
  })

  test('long text is split into segments within target length without losing text', () => {
    const text = '今天天气很好，我们去公园散步吧。'.repeat(60)
    const { length, segments } = splitText(text)
    expect(length).toBe(segments.length)
    expect(length).toBeGreaterThan(1)
    for (const segment of segments) {
      expect(segment.length).toBeLessThanOrEqual(500)
    }
    expect(segments.join('')).toBe(text)
  })

  test('punctuation-free long text is split via jieba without losing text', () => {
    const text = '天'.repeat(1200)
    const { segments } = splitText(text)
    expect(segments.join('')).toBe(text)
    expect(segments.every((segment) => segment.length <= 500)).toBe(true)
  })
})
