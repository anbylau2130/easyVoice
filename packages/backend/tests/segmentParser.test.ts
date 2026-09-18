// tests/segmentParser.test.ts
import {
  extractSegmentArray,
  normalizeSegments,
  isCoverageComplete,
} from '../src/llm/segmentParser'

const VOICES = ['zh-CN-YunxiNeural', 'zh-CN-XiaoyiNeural']

describe('extractSegmentArray', () => {
  test('accepts a top-level array', () => {
    const raw = [{ name: 'a', text: 'x' }]
    expect(extractSegmentArray(raw)).toEqual(raw)
  })

  test('accepts common wrapper keys', () => {
    for (const key of ['segments', 'result', 'data', 'list']) {
      expect(extractSegmentArray({ [key]: [{ text: 'x' }] })).toEqual([{ text: 'x' }])
    }
  })

  test('falls back to the only array property', () => {
    expect(extractSegmentArray({ voice_plan: [{ text: 'x' }] })).toEqual([{ text: 'x' }])
  })

  test('returns null when no array found', () => {
    expect(extractSegmentArray({})).toBeNull()
    expect(extractSegmentArray('string')).toBeNull()
    expect(extractSegmentArray({ a: 1, b: 'x' })).toBeNull()
  })
})

describe('normalizeSegments', () => {
  test('drops items without text and falls back to first allowed voice', () => {
    const segments = normalizeSegments(
      [
        { name: VOICES[0], text: '第一句' },
        { name: VOICES[1] },
        { text: '第二句' },
      ],
      VOICES
    )
    expect(segments).toEqual([
      { text: '第一句', voice: VOICES[0], rate: '+0%', volume: '+0%', pitch: '+0Hz' },
      { text: '第二句', voice: VOICES[0], rate: '+0%', volume: '+0%', pitch: '+0Hz' },
    ])
  })

  test('fixes missing +/- signs in rate/pitch/volume', () => {
    const segments = normalizeSegments(
      [{ name: VOICES[0], text: 'x', rate: '50%', volume: '-10%', pitch: '2Hz' }],
      VOICES
    )
    expect(segments[0]).toMatchObject({ rate: '+50%', volume: '-10%', pitch: '+2Hz' })
  })

  test('rejects hallucinated voices outside the allowed list', () => {
    const segments = normalizeSegments([{ name: 'made-up-voice', text: 'x' }], VOICES)
    expect(segments[0].voice).toBe(VOICES[0])
  })
})

describe('isCoverageComplete', () => {
  test('passes when text is fully covered', () => {
    expect(isCoverageComplete([{ text: '今天天气很好。' }], '今天天气很好。')).toBe(true)
  })

  test('ignores whitespace differences', () => {
    expect(isCoverageComplete([{ text: '今天 天气 很好。' }], '今天天气很好。')).toBe(true)
  })

  test('fails when the model drops text', () => {
    expect(
      isCoverageComplete([{ text: '今天天气' }], '今天天气很好，我们一起去公园散步吧。')
    ).toBe(false)
  })
})
