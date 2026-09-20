import { logger } from '../utils/logger'
import { safeRunWithRetry } from '../utils'
import { openai } from '../utils/openai'
import {
  getCharacterPlanPrompt,
  getCharacterSegmentPrompt,
  getPrompt,
} from './prompt/generateSegment'

/**
 * LLM 分段结果的提取、规范化与校验
 *
 * 模型返回的 JSON 结构差异很大（顶层数组、result/segments/data/list 等 key），
 * 解析失败或遗漏文本必须显式报错重试，绝不能静默跳过，
 * 否则会出现"只转换了一部分就结束"的音频。
 */

export interface NormalizedSegment {
  text: string
  voice: string
  rate: string
  volume: string
  pitch: string
  /** 情感风格（仅支持 express-as 的微软声音生效） */
  style?: string
  /** 情感强度 0.5~2 */
  styleDegree?: string
}

/** 角色-音色映射：整本书一份，保证同一角色跨章节音色一致 */
export interface CharacterVoice {
  character: string
  voice: string
  /** 角色性别 female/male（由规划阶段根据文中角色判定） */
  gender?: string
  description?: string
}

const SEGMENT_ARRAY_KEYS = ['segments', 'result', 'data', 'list']

/**
 * 从解析后的 LLM 响应中提取分段数组。
 * 找不到数组时返回 null，由调用方决定重试或报错。
 */
export function extractSegmentArray(parsed: unknown): Record<string, unknown>[] | null {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[]
  if (parsed && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    for (const key of SEGMENT_ARRAY_KEYS) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[]
    }
    // 兜底：对象上唯一的数组属性
    const arrayValues = Object.values(obj).filter((value) => Array.isArray(value))
    if (arrayValues.length === 1) return arrayValues[0] as Record<string, unknown>[]
  }
  return null
}

const normalizePercent = (value: unknown): string => {
  const match = typeof value === 'string' && value.trim().match(/^([+-]?\d+)%$/)
  if (!match) return '+0%'
  return match[1].startsWith('+') || match[1].startsWith('-') ? match[1] + '%' : `+${match[1]}%`
}

const normalizeHz = (value: unknown): string => {
  const match = typeof value === 'string' && value.trim().match(/^([+-]?\d+)Hz$/)
  if (!match) return '+0Hz'
  return match[1].startsWith('+') || match[1].startsWith('-') ? match[1] + 'Hz' : `+${match[1]}Hz`
}

// Edge-TTS 支持的情感风格（mstts:express-as）；normal 表示中性，不注入 SSML
const SUPPORTED_STYLES = new Set([
  'cheerful',
  'excited',
  'sad',
  'angry',
  'fearful',
  'whispering',
  'serious',
  'gentle',
  'calm',
  'disgruntled',
])

function normalizeStyle(item: Record<string, unknown>): { style?: string; styleDegree?: string } {
  const rawStyle = typeof item.style === 'string' ? item.style.trim().toLowerCase() : ''
  if (!SUPPORTED_STYLES.has(rawStyle)) return {}
  const degree = Number(item.styleDegree)
  const styleDegree =
    item.styleDegree !== undefined &&
    Number.isFinite(degree) &&
    degree >= 0.5 &&
    degree <= 2
      ? String(degree)
      : undefined
  return { style: rawStyle, styleDegree }
}

/**
 * 规范化分段：
 * - 丢弃没有 text 的项（并记录日志）
 * - resolveVoice 存在时用它决定 voice（角色映射模式）；否则按 name/voice 匹配声音列表
 * - rate/volume/pitch 补默认值并修正格式（如 "50%" → "+50%"），避免 Edge TTS 报错
 */
export function normalizeSegments(
  raw: Record<string, unknown>[],
  allowedVoices: string[],
  resolveVoice?: (item: Record<string, unknown>) => string | undefined
): NormalizedSegment[] {
  const fallbackVoice = allowedVoices[0]
  const segments: NormalizedSegment[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (!text) {
      logger.warn(`Dropping LLM segment without text: ${JSON.stringify(item).slice(0, 100)}`)
      continue
    }
    let voice: string
    if (resolveVoice) {
      voice = resolveVoice(item) ?? fallbackVoice
    } else {
      const candidates: (string | undefined)[] = [item.voice, item.name].map((candidate) =>
        typeof candidate === 'string' ? candidate : undefined
      )
      const matchedVoice = candidates.find(
        (candidate) => candidate && allowedVoices.includes(candidate)
      )
      voice = matchedVoice ?? fallbackVoice
      if (!matchedVoice) {
        logger.warn(
          `LLM segment voice not in voice list, falling back to ${fallbackVoice}: ${JSON.stringify(
            item
          ).slice(0, 100)}`
        )
      }
    }
    segments.push({
      text,
      voice,
      rate: normalizePercent(item.rate),
      volume: normalizePercent(item.volume),
      pitch: normalizeHz(item.pitch),
      ...normalizeStyle(item),
    })
  }
  return segments
}

/**
 * 校验分段文本对原文的覆盖率（按去除空白后的字符长度），
 * 防止模型遗漏或"总结"掉部分内容导致音频缺段。
 */
export function isCoverageComplete(
  segments: { text: string }[],
  sourceText: string,
  threshold = 0.85
): boolean {
  const clean = (text: string) => text.replace(/\s+/g, '')
  const sourceLength = clean(sourceText).length
  if (!sourceLength) return segments.length > 0
  const coveredLength = segments.reduce((sum, segment) => sum + clean(segment.text).length, 0)
  return coveredLength / sourceLength >= threshold
}

/**
 * 调用 LLM 为一段文本生成配音分段参数，带重试与完整校验。
 * 传入 characterVoices 时进入"固定角色映射"模式：
 * 分段只标注角色名，voice 严格按映射解析（次要角色回落旁白），保证跨章节音色一致。
 * 任何一步失败都会抛错（触发重试，重试耗尽则向上抛），不会返回"部分结果"。
 */
export async function fetchLlmSegments({
  lang,
  voiceList,
  text,
  retries = 3,
  characterVoices,
  extraVoiceIds = [],
}: {
  lang: string
  voiceList: VoiceConfig[]
  text: string
  retries?: number
  characterVoices?: CharacterVoice[]
  /** 追加的合法音色 ID（如自定义克隆音色），用于校验与回退 */
  extraVoiceIds?: string[]
}): Promise<NormalizedSegment[]> {
  const allowedVoices = [
    ...voiceList.map((voice) => voice.Name),
    ...extraVoiceIds,
  ]
  const mapping = new Map(
    (characterVoices || []).map((c) => [c.character.trim(), c.voice] as const)
  )
  const narratorVoice = characterVoices?.find((c) => c.character === '旁白')?.voice || allowedVoices[0]
  const prompt = characterVoices?.length
    ? getCharacterSegmentPrompt(
        lang,
        characterVoices
          .map(
            (c) =>
              `${c.character}（${c.gender === 'female' ? '女' : c.gender === 'male' ? '男' : '未知性别'}） -> ${c.voice}`
          )
          .join('\n'),
        text
      )
    : getPrompt(lang, voiceList, text)
  return safeRunWithRetry(
    async () => {
      const response = await openai.createChatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant. And you can return valid json object',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      })
      const content = response.choices[0]?.message?.content
      if (!content) {
        throw new Error('LLM returned empty content')
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        throw new Error(
          'LLM returned invalid JSON (possibly truncated), please switch to Edge TTS mode or use another model'
        )
      }
      const raw = extractSegmentArray(parsed)
      if (!raw?.length) {
        throw new Error(
          'LLM response does not contain a segments array, please switch to Edge TTS mode or use another model'
        )
      }
      const segments = normalizeSegments(raw, allowedVoices, (item) => {
        if (!characterVoices?.length) return undefined
        // 精确匹配 → 包含匹配（如 LLM 输出"宝玉"可命中映射表"贾宝玉"）
        const keys = [item.character, item.name]
          .filter((k) => typeof k === 'string')
          .map((k) => (k as string).trim())
        let mapped: string | undefined
        for (const key of keys) {
          if (mapping.has(key)) {
            mapped = mapping.get(key)
            break
          }
        }
        if (!mapped) {
          mapped = keys
            .map((key) => [...mapping.entries()].find(([name]) => name && (name.includes(key) || key.includes(name)))?.[1])
            .find(Boolean)
        }
        if (!mapped) {
          mapped = narratorVoice
          logger.warn(
            `Segment character not in mapping, using narrator: ${JSON.stringify(keys.filter(Boolean))}`
          )
        }
        return mapped
      })
      if (!segments.length) {
        throw new Error(
          'All LLM segments are missing text, please switch to Edge TTS mode or use another model'
        )
      }
      if (!isCoverageComplete(segments, text)) {
        throw new Error(
          'LLM segments do not cover the full input text, please switch to Edge TTS mode or use another model'
        )
      }
      return segments
    },
    {
      retries,
      baseDelayMs: 1000,
      onError: (err: unknown, attempt) =>
        logger.warn(`LLM segment attempt ${attempt} failed: ${(err as Error).message}`),
    }
  )
}

/** 规划 prompt 的标记，mock 测试服务器据此返回角色列表 */
export const CHARACTER_PLAN_MARKER = '【角色音色规划】'

/**
 * 第一阶段：通读书籍样本，规划"角色 -> 音色"映射（按性格选声，全书唯一）。
 * 校验：voice 必须在声音列表内；保证存在"旁白"角色。
 */
export async function planCharacterVoices({
  lang,
  voiceList,
  sampleText,
  retries = 2,
  extraVoices = [],
  narratorVoice,
}: {
  lang: string
  voiceList: VoiceConfig[]
  sampleText: string
  retries?: number
  /** 追加的候选音色 ID（如自定义克隆音色 custom-xxx），不受语言前缀过滤限制 */
  extraVoices?: string[]
  /** 指定旁白音色（叙述占比最大，允许用户指定） */
  narratorVoice?: string
}): Promise<CharacterVoice[]> {
  // AI 候选音色：中文书仅限大陆普通话（zh-CN），避免粤语/台湾腔被选中；英文书保持 en。
  // extraVoices（用户自建的克隆音色/预设）不受此限制
  const langFiltered = voiceList
    .filter((voice) => voice.Name.startsWith(lang === 'eng' ? 'en' : 'zh-CN'))
    .map((voice) => voice.Name)
  const allowedVoices = [...langFiltered, ...extraVoices]
  // 候选音色去重合并：voiceList 的完整条目（含性别）优先，extraVoices 中不在列表内的以裸 ID 补充
  const promptVoiceMap = new Map<string, { Name: string; Gender?: string }>()
  for (const name of extraVoices) promptVoiceMap.set(name, { Name: name })
  for (const voice of voiceList) {
    if (allowedVoices.includes(voice.Name)) promptVoiceMap.set(voice.Name, voice)
  }
  const promptVoiceList = [...promptVoiceMap.values()]
  const prompt = getCharacterPlanPrompt(lang, promptVoiceList, sampleText)
  // 音色性别对照表（VoiceConfig.Gender: Male/Female），用于纠正"女角色配男声"
  const voiceGender = new Map(
    voiceList.map((voice) => [voice.Name, voice.Gender?.toLowerCase()] as const)
  )

  const normalizeGender = (value: unknown): 'female' | 'male' | undefined => {
    if (typeof value !== 'string') return undefined
    const v = value.trim().toLowerCase()
    if (/^(f|female|女)/.test(v)) return 'female'
    if (/^(m|male|男)/.test(v)) return 'male'
    return undefined
  }

  return safeRunWithRetry(
    async () => {
      const response = await openai.createChatCompletion({
        messages: [
          {
            role: 'system',
            content: 'You are a helpful assistant. And you can return valid json object',
          },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_object' },
      })
      const content = response.choices[0]?.message?.content
      if (!content) throw new Error('LLM returned empty content')
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        throw new Error('LLM returned invalid JSON (character planning)')
      }
      const raw = extractSegmentArray(parsed)
      if (!raw?.length) {
        throw new Error('LLM character planning returned no entries')
      }
      const seen = new Map<string, CharacterVoice>()
      for (const item of raw) {
        const character =
          typeof item.character === 'string'
            ? item.character.trim()
            : typeof item.name === 'string'
            ? item.name.trim()
            : ''
        if (!character || seen.has(character)) continue
        let voice = allowedVoices.includes(item.voice as string)
          ? (item.voice as string)
          : allowedVoices[0]
        const gender = normalizeGender(item.gender)
        // 性别错配纠正：女性角色配了男声（或反之）时，换成分配性别一致的首个音色
        if (gender) {
          const voiceIsMale = voiceGender.get(voice) === 'male'
          const voiceIsFemale = voiceGender.get(voice) === 'female'
          if ((gender === 'female' && voiceIsMale) || (gender === 'male' && voiceIsFemale)) {
            const fixed =
              allowedVoices.find(
                (name) =>
                  (gender === 'female' && voiceGender.get(name) === 'female') ||
                  (gender === 'male' && voiceGender.get(name) === 'male')
              ) || voice
            logger.warn(
              `Character "${character}" gender=${gender} mismatched voice ${voice}, switched to ${fixed}`
            )
            voice = fixed
          }
        }
        // 中文书籍的描述必须是中文：推理模型偶发语言漂移输出英文描述，
        // 英文描述会直接进入试听朗读内容，必须丢弃
        let description =
          typeof item.description === 'string' ? item.description.slice(0, 100).trim() : undefined
        if (description && lang !== 'eng' && !/[\u4e00-\u9fff]/.test(description)) {
          logger.warn(`Character "${character}" description is not Chinese, dropping it`)
          description = undefined
        }
        seen.set(character, {
          character,
          voice,
          gender,
          description,
        })
      }
      if (seen.size < 1) {
        throw new Error('LLM character planning returned no valid characters')
      }
      // 旁白音色：优先用户指定（必须在合法列表内），否则用第一个合法音色
      const narrator =
        narratorVoice && allowedVoices.includes(narratorVoice) ? narratorVoice : allowedVoices[0]
      if (!seen.has('旁白')) {
        seen.set('旁白', { character: '旁白', voice: narrator })
      } else if (narratorVoice && allowedVoices.includes(narratorVoice)) {
        seen.get('旁白')!.voice = narratorVoice
      }
      return [...seen.values()]
    },
    {
      retries,
      baseDelayMs: 1000,
      onError: (err: unknown, attempt) =>
        logger.warn(`Character planning attempt ${attempt} failed: ${(err as Error).message}`),
    }
  )
}
