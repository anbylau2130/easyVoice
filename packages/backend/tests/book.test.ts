// tests/book.test.ts
import AdmZip from 'adm-zip'
import {
  splitTxtChapters,
  isChapterTitleLine,
  splitByLength,
  decodeText,
  parseEpub,
  parseBookFile,
} from '../src/services/book/chapter.service'

describe('isChapterTitleLine', () => {
  test.each([
    ['第一章 初入江湖', true],
    ['第12章', true],
    ['第三节、风雪', true],
    ['卷二', true],
    ['Chapter 3: The Beginning', true],
    ['序章', true],
    ['楔子：雪夜', true],
    ['这是第一章的正文内容', false],
    ['第一句话。', false],
    ['', false],
  ])('%s -> %s', (line, expected) => {
    expect(isChapterTitleLine(line)).toBe(expected)
  })
})

describe('splitTxtChapters', () => {
  test('splits by chapter title lines', () => {
    const text = [
      '第一章 起点',
      '少年走出山村，踏上了旅途。',
      '第二章 风雪',
      '风雪越来越大，他裹紧了衣裳继续前行。',
    ].join('\n')
    const chapters = splitTxtChapters(text)
    expect(chapters).toHaveLength(2)
    expect(chapters[0].title).toBe('第一章 起点')
    expect(chapters[0].content).toContain('山村')
    expect(chapters[1].title).toBe('第二章 风雪')
    expect(chapters[1].content).toContain('衣裳')
  })

  test('keeps text before first title as opening chapter', () => {
    const head = '这是一段很长的开篇内容，讲述了整个故事的背景设定与主要人物的前史。'.repeat(2)
    const text = `${head}\n第一章 开始\n正文内容。`
    const chapters = splitTxtChapters(text)
    expect(chapters[0].title).toBe('开篇')
    expect(chapters).toHaveLength(2)
  })

  test('single chapter when no markers and short text', () => {
    const chapters = splitTxtChapters('没有章节标记的普通文本。')
    expect(chapters).toHaveLength(1)
    expect(chapters[0].title).toBe('全文')
  })

  test('falls back to length-based split for long unmarked text', () => {
    const text = '山风吹过林梢，少年握紧手中的长剑，目光如电般扫过前方的山谷。'.repeat(200)
    const chapters = splitTxtChapters(text)
    expect(chapters.length).toBeGreaterThan(1)
    expect(chapters.map((c) => c.content).join('')).toBe(text)
  })
})

describe('splitByLength', () => {
  test('splits without losing text', () => {
    const text = '今天天气很好。我们一起去公园散步吧！你想去吗？'.repeat(100)
    const chapters = splitByLength(text, 4000)
    expect(chapters.map((c) => c.content).join('')).toBe(text)
    expect(chapters.every((c) => c.content.length <= 4200)).toBe(true)
  })
})

describe('decodeText', () => {
  test('keeps valid utf-8 as-is', () => {
    const buffer = Buffer.from('你好，世界。', 'utf-8')
    expect(decodeText(buffer)).toBe('你好，世界。')
  })

  test('falls back to gbk for gbk-encoded chinese', () => {
    // "天下" 的 GBK 编码为 CC EC CF C2，按 UTF-8 解码是非法序列（U+FFFD）
    const gbkBuffer = Buffer.from([0xcc, 0xec, 0xcf, 0xc2])
    expect(decodeText(gbkBuffer)).toBe('天下')
  })
})

function buildTestEpub(chapters: { title: string; paragraphs: string[] }[]): Buffer {
  const zip = new AdmZip()
  const opfDir = 'OEBPS'
  const manifest = chapters
    .map(
      (c, i) =>
        `<item id="ch${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>`
    )
    .join('')
  const spine = chapters.map((_, i) => `<itemref idref="ch${i}"/>`).join('')
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      `<?xml version="1.0"?><container><rootfiles><rootfile full-path="${opfDir}/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    )
  )
  zip.addFile(
    `${opfDir}/content.opf`,
    Buffer.from(
      `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
        <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试之书</dc:title></metadata>
        <manifest>${manifest}</manifest>
        <spine>${spine}</spine>
      </package>`
    )
  )
  chapters.forEach((c, i) => {
    const body = c.paragraphs.map((p) => `<p>${p}</p>`).join('')
    zip.addFile(
      `${opfDir}/ch${i}.xhtml`,
      Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?><html><head><style>p{}</style></head><body><h1>${c.title}</h1>${body}</body></html>`
      )
    )
  })
  return zip.toBuffer()
}

describe('parseEpub', () => {
  test('extracts title and chapters in spine order', () => {
    const epub = buildTestEpub([
      {
        title: '第一章',
        paragraphs: ['少年走出山村。'.repeat(20), '山外是广阔的世界。'.repeat(20)],
      },
      {
        title: '第二章',
        paragraphs: ['风雪夜归人。'.repeat(20), '他推开了那扇旧木门。'.repeat(20)],
      },
    ])
    const { title, chapters } = parseEpub(epub)
    expect(title).toBe('测试之书')
    expect(chapters).toHaveLength(2)
    expect(chapters[0].title).toBe('第一章')
    expect(chapters[0].content).toContain('山村')
    expect(chapters[1].content).toContain('木门')
  })

  test('merges very short consecutive chapters', () => {
    const epub = buildTestEpub([
      { title: '第一章', paragraphs: ['正文内容足够长。'.repeat(40)] },
      { title: '插页', paragraphs: ['短'] },
      { title: '第二章', paragraphs: ['另一段正文内容足够长。'.repeat(40)] },
    ])
    const { chapters } = parseEpub(epub)
    expect(chapters).toHaveLength(2)
    expect(chapters[0].content).toContain('短')
  })

  test('parseBookFile dispatches by extension', () => {
    const epub = buildTestEpub([{ title: '章节', paragraphs: ['内容。'] }])
    const fromEpub = parseBookFile('some book.epub', epub)
    expect(fromEpub.title).toBe('测试之书')
    const txtBuffer = Buffer.from('第一章 开始\n正文。', 'utf-8')
    const fromTxt = parseBookFile('book.txt', txtBuffer)
    expect(fromTxt.chapters).toHaveLength(1)
    expect(() => parseBookFile('book.pdf', Buffer.from('x'))).toThrow('仅支持')
  })
})
