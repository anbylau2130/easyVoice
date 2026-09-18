import AdmZip from 'adm-zip'

export interface ParsedChapter {
  title: string
  content: string
}

const CHAPTER_TITLE_PATTERNS = [
  /^第\s*[0-9〇零一二三四五六七八九十百千万两]+\s*[章节回卷部篇集]/,
  /^Chapter\s+\d+/i,
  /^(序章|序言|楔子|引子|前言|后记|尾声|终章|番外)([\s:：.．、].*)?$/,
  /^卷\s*[0-9〇零一二三四五六七八九十百千万两]+/,
]

const FALLBACK_CHAPTER_LENGTH = 4000
const FALLBACK_MIN_LENGTH = 5000
/** 比这更短的连续 epub 章节并入前一章 */
const EPUB_MERGE_THRESHOLD = 200

/** 行是否像章节标题（保守匹配，宁漏勿错） */
export function isChapterTitleLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed || trimmed.length > 60) return false
  if (/[。！？!?]$/.test(trimmed)) return false
  return CHAPTER_TITLE_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/**
 * txt 解码：优先 UTF-8，replacement 字符过多时回退 GBK（Node 自带 full-icu）
 */
export function decodeText(buffer: Buffer): string {
  const utf8 = buffer.toString('utf-8')
  const bad = (utf8.match(/\uFFFD/g) || []).length
  if (bad === 0 || bad / utf8.length < 0.001) return utf8
  try {
    const gbk = new TextDecoder('gbk').decode(buffer)
    if ((gbk.match(/\uFFFD/g) || []).length < bad) return gbk
  } catch {
    // 环境不支持 GBK 解码时保持 UTF-8 结果
  }
  return utf8
}

/**
 * 按章节标题行切分 txt；首个标题前的内容作为"开篇"；
 * 没有任何标题且文本过长时，在句子边界按固定长度兜底切分。
 */
export function splitTxtChapters(text: string): ParsedChapter[] {
  const lines = text.split(/\r?\n/)
  const marks: { title: string; line: number }[] = []
  lines.forEach((line, i) => {
    if (isChapterTitleLine(line)) marks.push({ title: line.trim(), line: i })
  })

  if (marks.length === 0) {
    if (text.length <= FALLBACK_MIN_LENGTH) {
      return [{ title: '全文', content: text.trim() }]
    }
    return splitByLength(text, FALLBACK_CHAPTER_LENGTH)
  }

  const chapters: ParsedChapter[] = []
  const head = lines.slice(0, marks[0].line).join('\n').trim()
  if (head.length > 50) chapters.push({ title: '开篇', content: head })

  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? marks[i + 1].line : lines.length
    const content = lines.slice(mark.line + 1, end).join('\n').trim()
    if (content) chapters.push({ title: mark.title, content })
  })
  return chapters
}

/** 无标记长文本兜底：在句子边界按 targetLength 切分 */
export function splitByLength(text: string, targetLength: number): ParsedChapter[] {
  const sentences = text.split(/(?<=[。！？!?\n])/)
  const chapters: ParsedChapter[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current && (current + sentence).length > targetLength) {
      chapters.push({ title: `第${chapters.length + 1}部分`, content: current.trim() })
      current = ''
    }
    current += sentence
  }
  if (current.trim()) {
    chapters.push({ title: `第${chapters.length + 1}部分`, content: current.trim() })
  }
  return chapters
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<head[\s\S]*?<\/head>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|blockquote)\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}

function matchFirst(text: string, pattern: RegExp): string | undefined {
  return text.match(pattern)?.[1]
}

/** 连续过短的 epub 章节并入前一章 */
function mergeShortChapters(chapters: ParsedChapter[]): ParsedChapter[] {
  const merged: ParsedChapter[] = []
  for (const chapter of chapters) {
    const previous = merged[merged.length - 1]
    if (previous && chapter.content.length < EPUB_MERGE_THRESHOLD) {
      previous.content += `\n${chapter.title}\n${chapter.content}`
    } else {
      merged.push({ ...chapter })
    }
  }
  return merged
}

/**
 * 解析 EPUB：container.xml → OPF → spine 顺序提取每个文档的正文
 */
export function parseEpub(buffer: Buffer): { title: string; chapters: ParsedChapter[] } {
  const zip = new AdmZip(buffer)
  const container = zip.readAsText('META-INF/container.xml')
  const opfPath = matchFirst(container, /full-path="([^"]+)"/)
  if (!opfPath) throw new Error('EPUB 缺少 container.xml 或 OPF 元数据')

  const opf = zip.readAsText(opfPath)
  const rawTitle = matchFirst(opf, /<dc:title[^>]*>([\s\S]*?)<\/dc:title>/)
  const title = rawTitle ? stripTags(rawTitle) : opfPath.replace(/.*\//, '').replace(/\.opf$/i, '')

  const opfDir = opfPath.includes('/') ? opfPath.slice(0, opfPath.lastIndexOf('/')) : ''
  const manifest = new Map<string, string>()
  for (const match of opf.matchAll(/<item\b[^>]*>/g)) {
    const tag = match[0]
    const id = matchFirst(tag, /\bid="([^"]+)"/)
    const href = matchFirst(tag, /\bhref="([^"]+)"/)
    const mediaType = matchFirst(tag, /\bmedia-type="([^"]+)"/)
    if (id && href && mediaType?.includes('html')) manifest.set(id, href)
  }
  const spineIds = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => m[1])

  const chapters: ParsedChapter[] = []
  for (const id of spineIds) {
    const href = manifest.get(id)
    if (!href) continue
    const entry = decodeURIComponent(`${opfDir ? opfDir + '/' : ''}${href}`)
      .replace(/\\/g, '/')
      .replace(/^\//, '')
    const file = zip.getEntry(entry) || zip.getEntry(href)
    if (!file) continue
    const html = file.getData().toString('utf-8')
    const content = htmlToText(html)
    if (!content) continue
    const heading = matchFirst(html, /<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i)
    const chapterTitle =
      (heading && stripTags(heading).slice(0, 100)) ||
      (chapters.length === 0 ? '开篇' : `章节 ${chapters.length + 1}`)
    chapters.push({ title: chapterTitle, content })
  }

  const merged = mergeShortChapters(chapters)
  if (!merged.length) throw new Error('EPUB 中未解析到正文内容')
  return { title, chapters: merged }
}

/**
 * 按文件名分发解析：.epub → epub 解析；.txt/.text → txt 切章
 */
export function parseBookFile(
  filename: string,
  buffer: Buffer
): { title: string; chapters: ParsedChapter[] } {
  const lower = filename.toLowerCase()
  const defaultTitle = filename.replace(/\.[^.]+$/, '') || '未命名有声书'
  if (lower.endsWith('.epub')) {
    const parsed = parseEpub(buffer)
    return { title: parsed.title || defaultTitle, chapters: parsed.chapters }
  }
  if (lower.endsWith('.txt') || lower.endsWith('.text')) {
    const text = decodeText(buffer)
    if (!text.trim()) throw new Error('文件内容为空')
    return { title: defaultTitle, chapters: splitTxtChapters(text) }
  }
  throw new Error('仅支持 .epub 和 .txt 文件')
}
