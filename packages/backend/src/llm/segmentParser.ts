import { logger } from '../utils/logger'
import { asyncSleep, safeRunWithRetry } from '../utils'
import { openai } from '../utils/openai'
import {
  getCharacterAssignPrompt,
  getCharacterPlanPrompt,
  getCharacterSegmentPrompt,
  getCharacterSurveyPrompt,
  getCharacterVoiceMatchPrompt,
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
  /** 换声源：openvoice=参考音频名 / rvc=模型名；由角色表绑定经映射带入 */
  vcRef?: string
}

/** 角色-音色映射：整本书一份，保证同一角色跨章节音色一致 */
export interface CharacterVoice {
  character: string
  voice: string
  /** 角色性别 female/male（由规划阶段根据文中角色判定） */
  gender?: string
  description?: string
  /** 全书对白句数（权重：排序与取舍依据） */
  dialog?: number
  /** 该角色在书中的其他称呼（与 character 指同一人） */
  aliases?: string[]
  /** 换声源绑定：openvoice=参考音频名 / rvc=RVC 模型名（voice 仍是合成用基础音色） */
  vcRef?: string
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
  resolveVoice?: (item: Record<string, unknown>) => { voice: string; vcRef?: string } | undefined
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
    let vcRef: string | undefined
    if (resolveVoice) {
      const resolved = resolveVoice(item)
      voice = resolved?.voice ?? fallbackVoice
      vcRef = resolved?.vcRef
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
      vcRef,
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
  // 角色 → 映射条目（音色 + 换声源），按正名与别名都可命中
  const mapping = new Map(
    (characterVoices || []).map((c) => [c.character.trim(), c] as const)
  )
  const narratorEntry = characterVoices?.find((c) => c.character === '旁白')
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
        let mapped: (typeof characterVoices)[number] | undefined
        for (const key of keys) {
          if (mapping.has(key)) {
            mapped = mapping.get(key)
            break
          }
        }
        if (!mapped) {
          mapped = keys
            .map((key) =>
              [...mapping.entries()].find(
                ([name]) => name && (name.includes(key) || key.includes(name))
              )?.[1]
            )
            .find(Boolean)
        }
        if (!mapped) {
          mapped = narratorEntry
          logger.warn(
            `Segment character not in mapping, using narrator: ${JSON.stringify(keys.filter(Boolean))}`
          )
        }
        return mapped ? { voice: mapped.voice, vcRef: mapped.vcRef } : undefined
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
      // 内容安全拦截（400 + "敏感/安全"提示）对相同输入必然复现，重试无意义，
      // 立即抛给调用方做二分/旁白兜底
      retryOn: (err) => {
        const message = err instanceof Error ? err.message : String(err)
        return !/敏感|不安全|status code 400/.test(message)
      },
    }
  )
}

/** 规划 prompt 的标记，mock 测试服务器据此返回角色列表 */
export const CHARACTER_PLAN_MARKER = '【角色音色规划】'

// ===== 全书通读规划：人物普查（分块并发）→ 汇总统计 → 音色分配 =====

export interface CharacterStat {
  name: string
  gender: 'female' | 'male' | 'unknown'
  /** 全书对白句数（各块累加） */
  dialog: number
  brief?: string
  /** 本章中该人物实际使用的称呼（收集进 aliases） */
  mentioned?: string
}

/** 宽松 JSON 提取：容忍 ```json 围栏与前后杂文，截取首个完整 JSON 对象 */
export function parseJsonLoose(text: string): unknown {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```\s*$/, '')
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('no JSON object found in response')
  }
  return JSON.parse(cleaned.slice(start, end + 1))
}

/** 逐章成块；单章超过 chunkSize 时硬切成多个部分（进度仍按该章显示） */
function buildChunks(
  items: { content: string; label: string }[],
  chunkSize: number
): { text: string; label: string }[] {
  const chunks: { text: string; label: string }[] = []
  for (const item of items) {
    const text = (item.content || '').trim()
    if (!text) continue
    if (text.length <= chunkSize) {
      chunks.push({ text, label: item.label })
      continue
    }
    const parts = Math.ceil(text.length / chunkSize)
    for (let i = 0; i < parts; i++) {
      chunks.push({
        text: text.slice(i * chunkSize, (i + 1) * chunkSize),
        label: `${item.label}（第 ${i + 1}/${parts} 部分）`,
      })
    }
  }
  return chunks
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 阶段一（通读）：逐章提取人物统计，跨章合并去重（对白句数累加、性别投票）。
 * 每章一次调用——进度按章推进，前端实时可见；章与章之间串行并留间隔，
 * 避免触发 LLM 服务限速；单章失败只跳过该章并告警。
 * onProgress 在每章开始时回调进度描述（如"正在通读 第 12/60 章"）。
 */
export async function surveyBookCharacters({
  texts,
  lang = 'zh',
  // 单章超过此长度时内部硬切成多个部分（进度仍按该章显示）
  chunkSize = 30000,
  concurrency = 1,
  onProgress,
  onStats,
  getRosterNames,
  shouldStop,
}: {
  /** 章节正文列表，label 为章节显示名（如"第 12/60 章"） */
  texts: { content: string; label: string }[]
  lang?: string
  chunkSize?: number
  concurrency?: number
  onProgress?: (label: string) => void
  /** 每章普查成功后回调该章的人物统计（供上层增量合并进角色表） */
  onStats?: (stats: CharacterStat[]) => void
  /** 返回当前已登记人物正式名列表（普查 prompt 用于别名归并到正式名） */
  getRosterNames?: () => Promise<string[]> | string[]
  /** 返回 true 时在下一章边界停止通读（当前章会读完），返回已收集的部分统计 */
  shouldStop?: () => boolean
}): Promise<CharacterStat[]> {
  const chunks = buildChunks(texts, chunkSize)
  if (!chunks.length) throw new Error('全书正文为空，无法进行人物普查')
  logger.info(`Character survey: ${chunks.length} chunk(s), ${concurrency} concurrent`)

  const chunkResults = await mapPool(chunks, concurrency, async (chunk, idx) => {
    try {
      // 停止请求：下一章边界生效（当前章会读完）
      if (shouldStop?.()) {
        onProgress?.('收到停止请求，正在结束通读…')
        return [] as CharacterStat[]
      }
      onProgress?.(`正在通读 ${chunk.label}`)
      const rosterNames = getRosterNames ? await getRosterNames() : []
      // 单章抽取两级策略：
      // 1) 快速模式（GLM 关思考）——速度快，但遇到人物密集/长章节可能抽不出人物；
      // 2) 抽空立即升级深度模式（开启思考）重跑。
      // 空结果不做同模式原地重试（重试也是空）；仅传输类错误（429/超时/5xx）退避重试
      const extractChunk = async (thinking: boolean) => {
        let lastErr: Error | undefined
        const attempts = thinking ? 2 : 3
        for (let attempt = 1; attempt <= attempts; attempt++) {
          try {
            const response = await openai.createChatCompletion({
              messages: [
                { role: 'system', content: 'You are a helpful assistant. And you can return valid json object' },
                { role: 'user', content: getCharacterSurveyPrompt(lang, chunk.text, rosterNames) },
              ],
              temperature: 0.2,
              max_tokens: 3000,
              ...(thinking ? {} : openai.fastExtractFields(openai.getModel())),
              response_format: { type: 'json_object' },
            })
            const content = response.choices[0]?.message?.content
            if (!content) throw new Error('LLM returned empty content')
            const parsed = JSON.parse(content)
            const arr = extractSegmentArray(parsed)
            if (!arr?.length) throw new Error('survey returned no entries')
            const stats: CharacterStat[] = []
            for (const item of arr) {
              const name = typeof item.name === 'string' ? item.name.trim() : ''
              if (!name || name.length > 20) continue
              const gender =
                item.gender === 'female' ? 'female' : item.gender === 'male' ? 'male' : 'unknown'
              const dialog = Number.isFinite(Number(item.dialog)) ? Math.max(0, Number(item.dialog)) : 0
            stats.push({
              name,
              gender,
              dialog,
              brief: typeof item.brief === 'string' ? item.brief.slice(0, 12) : undefined,
              mentioned:
                typeof item.asMentioned === 'string' ? item.asMentioned.trim().slice(0, 20) : undefined,
            })
            }
            if (!stats.length) throw new Error('survey returned no valid entries')
            return stats
          } catch (err) {
            lastErr = err as Error
            const message = lastErr.message
            const empty = message.includes('no entries') || message.includes('no valid entries')
            const rateLimited = message.includes('429')
            logger.warn(
              `Character survey chunk ${idx + 1} attempt ${attempt} (${thinking ? '深度' : '快速'}): ${message}`
            )
            if (empty) {
              // 空结果重试同模式没有意义，立即交由外层升级深度模式
              break
            }
            if (attempt < attempts) {
              const delay = rateLimited ? Math.min(45_000, 15_000 * attempt) : 5_000 * attempt
              onProgress?.(
                `（${chunk.label}）第 ${attempt} 次尝试失败（${message.slice(0, 60)}），${Math.round(delay / 1000)} 秒后自动重试…`
              )
              await asyncSleep(delay)
            }
          }
        }
        return []
      }
      let stats = await extractChunk(false)
      if (!stats.length) {
        logger.info(`Chunk ${idx + 1} empty in fast mode, retrying with thinking enabled`)
        onProgress?.(`（${chunk.label}）快速抽取为空，启用深度模式重试…`)
        stats = await extractChunk(true)
      }
      // 每章普查成功后立即回调，上层把新角色增量合并进角色表
      if (stats.length) onStats?.(stats)
      // 章间留出间隔，降低触发服务端限速的概率
      await asyncSleep(2000)
      return stats
    } catch (err) {
      logger.warn(`Character survey chunk ${idx + 1} skipped: ${(err as Error).message}`)
      return [] as CharacterStat[]
    }
  })

  // 跨块合并：对白累加，性别投票（unknown 不计票）
  const merged = new Map<string, CharacterStat & { _f: number; _m: number }>()
  let successChunks = 0
  for (const stats of chunkResults) {
    if (!stats.length) continue
    successChunks++
    for (const s of stats) {
      const prev = merged.get(s.name)
      if (!prev) {
        merged.set(s.name, {
          name: s.name,
          gender: s.gender,
          dialog: s.dialog,
          brief: s.brief,
          _f: s.gender === 'female' ? 1 : 0,
          _m: s.gender === 'male' ? 1 : 0,
        })
        continue
      }
      prev.dialog += s.dialog
      if (s.gender === 'female') prev._f++
      if (s.gender === 'male') prev._m++
      if (!prev.brief && s.brief) prev.brief = s.brief
    }
  }
  if (!successChunks) throw new Error('人物普查全部失败，请检查 AI 模型配置或稍后重试')
  // 称呼归并（确定性）：短称呼是长称呼的子串时（如 宝玉 ⊂ 贾宝玉、袭人 ⊂ 花袭人），
  // 统计合并进长称呼，避免同一角色被拆成多行。要求短称呼至少 2 字，防止单字误并
  const allNames = [...merged.keys()]
  for (const short of allNames) {
    if (short.length < 2) continue
    const long = allNames.find(
      (n) => n !== short && merged.has(n) && n.length > short.length && n.includes(short)
    )
    if (!long) continue
    const s = merged.get(short)!
    const t = merged.get(long)!
    t.dialog += s.dialog
    t._f += s._f
    t._m += s._m
    if (!t.brief && s.brief) t.brief = s.brief
    merged.delete(short)
    logger.info(`Merged alias "${short}" into "${long}" (survey)`)
  }
  const result: CharacterStat[] = [...merged.values()].map(({ _f, _m, ...s }) => ({
    ...s,
    gender: _f >= _m && _f > 0 ? 'female' : _m > 0 ? 'male' : 'unknown',
  }))
  logger.info(
    `Character survey done: ${result.length} unique characters from ${successChunks}/${chunks.length} chunks`
  )
  return result.sort((a, b) => b.dialog - a.dialog)
}

/**
 * 通读完成后，按角色性格从预设库中挑选最贴合的音色。
 * 角色需带性别与性格描述（describeCharacters 的产物），预设名即性格标签。
 * 返回 角色名 -> 预设音色 ID 的映射；无法匹配的角色由上层保留原音色。
 */
export async function assignVoicesByPersonality({
  lang = 'zh',
  characters,
  presets,
  retries = 2,
}: {
  lang?: string
  characters: { character: string; gender?: string; description?: string; dialog?: number }[]
  presets: { id: string; name: string; gender?: string }[]
  retries?: number
}): Promise<Map<string, string>> {
  const presetIds = new Set(presets.map((p) => p.id))
  const charTable = characters
    .map(
      (c) =>
        `${c.character} | ${c.gender || 'unknown'} | 对白${c.dialog || 0}句 | ${c.description || ''}`
    )
    .join('\n')
  const presetTable = presets
    .map((p) => `${p.name} | ${p.id} | ${(p.gender || '').toLowerCase() || 'unknown'}`)
    .join('\n')
  const out = new Map<string, string>()
  try {
    return await safeRunWithRetry(
      async () => {
        const response = await openai.createChatCompletion({
          messages: [
            { role: 'system', content: 'You are a helpful assistant. And you can return valid json object' },
            { role: 'user', content: getCharacterVoiceMatchPrompt(lang, charTable, presetTable) },
          ],
          temperature: 0.2,
          max_tokens: 3000,
          ...openai.fastExtractFields(openai.getModel()),
          response_format: { type: 'json_object' },
        })
        const content = response.choices[0]?.message?.content
        if (!content) throw new Error('LLM returned empty content')
        const parsed = JSON.parse(content)
        const arr = extractSegmentArray(parsed)
        if (!arr?.length) throw new Error('voice match returned no entries')
        for (const item of arr) {
          const character = typeof item.character === 'string' ? item.character.trim() : ''
          const voice = typeof item.voice === 'string' ? item.voice.trim() : ''
          if (character && voice && presetIds.has(voice)) out.set(character, voice)
        }
        if (!out.size) throw new Error('voice match returned no valid assignments')
        return out
      },
      { retries, baseDelayMs: 3000 }
    )
  } catch (err) {
    logger.warn(`Voice personality matching failed: ${(err as Error).message}`)
    return out
  }
}

/**
 * 通读完成后，为全部角色生成一句中文性格/身份描述（替代普查阶段的简短提示）。
 * 失败时返回空映射，上层回落使用普查身份提示，不影响规划结果。
 */
export async function describeCharacters({
  lang = 'zh',
  characters,
  retries = 2,
  onProgress,
}: {
  lang?: string
  characters: {
    name: string
    dialog?: number
    brief?: string
    aliases?: string[]
  }[]
  retries?: number
  /** 每个角色的描述进度回调（如"正在生成角色性格描述（3/30）：王熙凤"） */
  onProgress?: (label: string) => void
}): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  // 逐角色生成详细描述：单角色小任务，关思考即可输出高质量长文本，
  // 串行执行避免限速；单角色失败只跳过该角色，不影响其他角色
  let done = 0
  for (const c of characters) {
    const aliasText = c.aliases?.length ? `（书中又称：${c.aliases.join('、')}）` : ''
    const label = `正在生成角色性格描述（${done + 1}/${characters.length}）：${c.name}`
    onProgress?.(label)
    try {
      const response = await safeRunWithRetry(
        async () =>
          await openai.createChatCompletion({
            messages: [
              { role: 'system', content: 'You are a helpful assistant. And you can return valid json object' },
              {
                role: 'user',
                content: `请为小说角色写一段详细的人物描述。角色：${c.name}${aliasText}；身份提示：${c.brief || '未知'}；全书对白 ${c.dialog || 0} 句。要求：以所有称呼开头，然后详细描述其性格特点、身份背景、说话语气（结合对白数推断：对白多者健谈、无对白者沉默寡言），共 80~150 字。直接输出 JSON：{"description":"..."}`,
              },
            ],
            temperature: 0.5,
            max_tokens: 1500,
            ...openai.fastExtractFields(openai.getModel()),
          }),
        { retries, baseDelayMs: 3000 }
      )
      const content = response.choices[0]?.message?.content
      if (!content) throw new Error('LLM returned empty content')
      const parsed = parseJsonLoose(content) as { description?: string }
      const desc = typeof parsed.description === 'string' ? parsed.description.trim() : ''
      if (!desc) throw new Error('empty description')
      out.set(c.name, desc.slice(0, 200))
      done++
      logger.info(`Character described: ${c.name} (${desc.length} chars)`)
    } catch (err) {
      logger.warn(`Describe failed for ${c.name}: ${(err as Error).message}`)
    }
  }
  return out
}

/**
 * 阶段二（确定）：取对白数最多的前 topN 名角色，为其分配音色。
 * 校验与 planCharacterVoices 一致：合法音色、性别错配纠正、中文描述、旁白兜底。
 */
export async function planCharactersFromSurvey({
  lang,
  voiceList,
  stats,
  topN = 30,
  extraVoices = [],
  narratorVoice,
  retries = 4,
}: {
  lang: string
  voiceList: VoiceConfig[]
  stats: CharacterStat[]
  topN?: number
  extraVoices?: string[]
  narratorVoice?: string
  retries?: number
}): Promise<CharacterVoice[]> {
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
  const table = stats
    .filter((s) => s.name !== '旁白')
    .slice(0, topN)
    .map((s) => `${s.name} | ${s.gender} | 对白${s.dialog}句${s.brief ? ` | ${s.brief}` : ''}`)
    .join('\n')
  const prompt = getCharacterAssignPrompt(lang, [...promptVoiceMap.values()], table)
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
          { role: 'system', content: 'You are a helpful assistant. And you can return valid json object' },
          { role: 'user', content: prompt },
        ],
        temperature: 0.2,
        // 音色分配同样是结构化提取：关闭推理模型思考提速
        ...openai.fastExtractFields(openai.getModel()),
        response_format: { type: 'json_object' },
      })
      const content = response.choices[0]?.message?.content
      if (!content) throw new Error('LLM returned empty content')
      let parsed: unknown
      try {
        parsed = JSON.parse(content)
      } catch {
        throw new Error('LLM returned invalid JSON (character assignment)')
      }
      const raw = extractSegmentArray(parsed)
      if (!raw?.length) throw new Error('LLM character assignment returned no entries')
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
        let description =
          typeof item.description === 'string' ? item.description.slice(0, 100).trim() : undefined
        if (description && lang !== 'eng' && !/[\u4e00-\u9fff]/.test(description)) {
          logger.warn(`Character "${character}" description is not Chinese, dropping it`)
          description = undefined
        }
        seen.set(character, { character, voice, gender, description })
      }
      if (seen.size < 1) throw new Error('LLM character assignment returned no valid characters')
      // 称呼归并兜底：角色名互为包含时（如"宝玉"⊂"贾宝玉"）合并短入长，保证同一角色单一音色
      for (const [name] of [...seen]) {
        if (name.length < 2 || !seen.has(name)) continue
        const long = [...seen.keys()].find(
          (n) => n !== name && seen.has(n) && n.length > name.length && n.includes(name)
        )
        if (long) {
          seen.delete(name)
          logger.info(`Merged duplicate character "${name}" into "${long}" (assignment)`)
        }
      }
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
      baseDelayMs: 5000,
      onError: (err: unknown, attempt) =>
        logger.warn(`Character assignment attempt ${attempt} failed: ${(err as Error).message}`),
    }
  )
}

/**
 * 第一阶段：通读书籍样本，规划"角色 -> 音色"映射（按性格选声，全书唯一）。
 * 校验：voice 必须在声音列表内；保证存在"旁白"角色。
 */
export async function planCharacterVoices({
  lang,
  voiceList,
  sampleText,
  retries = 4,
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
        // 角色规划要求稳定：低温采样，同样书籍多次规划得到基本一致的角色名单
        temperature: 0.2,
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
      baseDelayMs: 5000,
      onError: (err: unknown, attempt) =>
        logger.warn(`Character planning attempt ${attempt} failed: ${(err as Error).message}`),
    }
  )
}
