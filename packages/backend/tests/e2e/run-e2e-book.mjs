// tests/e2e/run-e2e-book.mjs
// 有声书端到端测试：需先启动 mock LLM 与后端（同 run-e2e.mjs 前置条件）
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000/api/v1/book'
const MOCK = process.env.E2E_MOCK_URL || 'http://127.0.0.1:9333'
const VOICES_BASE = process.env.E2E_VOICES_URL || 'http://localhost:3001/api/v1/voices'
const SETTINGS_BASE =
  process.env.E2E_SETTINGS_URL || 'http://localhost:3001/api/v1/settings'

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  PASS ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const runId = Date.now()
// 章节文本带 runId：避免跨运行命中持久化音频缓存
const chapterText = (mark) => `本书编号${runId}。${mark}这是第一章的正文内容，少年背起行囊告别了故乡的亲人。`.repeat(8)

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(180_000),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function setMode(mode) {
  const res = await fetch(`${MOCK}/mode`, { method: 'POST', body: mode })
  if (!res.ok) throw new Error(`setMode(${mode}) failed`)
}

// 套件开始前确保没有遗留的生成任务占用单本锁（上一轮失败遗留等场景）
async function ensureIdle() {
  const { json } = await api('GET', '/list')
  for (const book of json?.data || []) {
    if (book.status !== 'running') continue
    console.log(`  (暂停遗留的生成任务 ${book.id} 以释放单本锁)`)
    await api('POST', `/${book.id}/pause`)
    await waitForBook(book.id, (b) => b.status === 'paused', 600_000, `暂停遗留书 ${book.id}`)
  }
}

async function waitForBook(id, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  let book = null
  while (Date.now() < deadline) {
    const { json } = await api('GET', `/${id}`)
    book = json?.data || null
    if (book && predicate(book)) return book
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
  throw new Error(`等待超时（${label}），最后状态: ${JSON.stringify(book).slice(0, 300)}`)
}

// 套件开始前暂停遗留的生成任务，释放单本锁
await ensureIdle()

// B1 txt 解析：按章节标题切分
{
  const txt = [
    '这是开篇的引言部分，交代了整个故事发生的时代背景、天下大势，'.repeat(2),
    '第一章 初入江湖',
    '少年走出山村，踏上了旅途。'.repeat(10),
    '第二章 风雪夜',
    '风雪越来越大，他裹紧了衣裳继续前行。'.repeat(10),
    '第三章 比武',
    '擂台之上，他一剑惊四座。'.repeat(10),
  ].join('\n')
  const { status, json } = await api('POST', '/parseBook', {
    filename: `测试小说${runId}.txt`,
    contentBase64: Buffer.from(txt, 'utf-8').toString('base64'),
  })
  const chapters = json?.data?.chapters || []
  check(
    'B1 parseBook(txt) 按标题切章',
    status === 200 && chapters.length === 4 && chapters[0].title === '开篇',
    JSON.stringify(json?.data?.chapters?.map((c) => c.title))
  )
}

// B2 epub 解析
{
  const { default: AdmZip } = await import('adm-zip')
  const zip = new AdmZip()
  const chapters = [
    { title: '第一章', paragraphs: ['少年走出山村。'.repeat(40)] },
    { title: '第二章', paragraphs: ['风雪夜归人。'.repeat(40)] },
  ]
  const manifest = chapters
    .map((_, i) => `<item id="ch${i}" href="ch${i}.xhtml" media-type="application/xhtml+xml"/>`)
    .join('')
  const spine = chapters.map((_, i) => `<itemref idref="ch${i}"/>`).join('')
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      `<container><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
    )
  )
  zip.addFile(
    'OEBPS/content.opf',
    Buffer.from(
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>EPUB测试书${runId}</dc:title></metadata><manifest>${manifest}</manifest><spine>${spine}</spine></package>`
    )
  )
  chapters.forEach((c, i) => {
    zip.addFile(
      `OEBPS/ch${i}.xhtml`,
      Buffer.from(
        `<html><body><h1>${c.title}</h1>${c.paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>`
      )
    )
  })
  const { status, json } = await api('POST', '/parseBook', {
    filename: `book${runId}.epub`,
    contentBase64: zip.toBuffer().toString('base64'),
  })
  check(
    'B2 parseBook(epub) 按目录解析',
    status === 200 && json?.data?.chapters?.length === 2,
    JSON.stringify(json).slice(0, 200)
  )
}

const bookParams = {
  voice: 'zh-CN-YunxiNeural',
  rate: '+0%',
  pitch: '+0Hz',
  volume: '+0%',
  useLLM: false,
}

// B3 创建 + 生成 + 逐章下载
{
  const chapters = ['甲', '乙', '丙'].map((mark, i) => ({
    title: `第${i + 1}章-${mark}-${runId}`,
    content: chapterText(`（${mark}）`),
  }))
  const created = await api('POST', '/create', { title: `E2E有声书${runId}`, chapters, params: bookParams })
  const bookId = created.json?.data?.bookId
  check('B3a 创建有声书并自动开始', created.status === 200 && !!bookId, JSON.stringify(created.json).slice(0, 200))
  // Edge 偶发抖动可能产生失败章：允许一轮生成 + 一轮重试
  let book = await waitForBook(
    bookId,
    (b) => b.status === 'completed' || b.status === 'paused',
    420_000,
    '生成完成'
  )
  if (book.status === 'paused') {
    await api('POST', `/${bookId}/retryFailed`)
    book = await waitForBook(bookId, (b) => b.status === 'completed', 420_000, '重试后完成')
  }
  check(
    'B3b 三章全部完成',
    book.chapters.filter((c) => c.status === 'done').length === 3,
    JSON.stringify(book.chapters.map((c) => c.status))
  )
  let allMp3 = true
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${BASE}/${bookId}/chapter/${i}/audio`, { signal: AbortSignal.timeout(30_000) })
    const buf = Buffer.from(await res.arrayBuffer())
    const isMp3 = buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
    if (!(res.status === 200 && buf.length > 1000 && isMp3)) allMp3 = false
  }
  check('B3c 逐章音频可下载且为有效 MP3', allMp3)
}

// B4 暂停 → 续传
{
  const chapters = ['一', '二', '三', '四', '五'].map((mark, i) => ({
    title: `暂停测试第${i + 1}章-${runId}`,
    content: chapterText(`（暂停${mark}）`) + chapterText(`（补充${mark}）`),
  }))
  const created = await api('POST', '/create', {
    title: `暂停续传书${runId}`,
    chapters,
    params: bookParams,
  })
  const bookId = created.json?.data?.bookId
  await waitForBook(bookId, (b) => b.status === 'running', 30_000, '开始运行')
  await api('POST', `/${bookId}/pause`)
  const paused = await waitForBook(bookId, (b) => b.status === 'paused', 420_000, '暂停')
  const doneAtPause = paused.chapters.filter((c) => c.status === 'done').length
  check('B4a 手动暂停在章节边界生效且保留进度', doneAtPause > 0 && doneAtPause < 5, `done=${doneAtPause}`)
  const resumed = await api('POST', `/${bookId}/resume`)
  check('B4b 续传请求被接受', resumed.status === 200, JSON.stringify(resumed.json).slice(0, 160))
  const done = await waitForBook(bookId, (b) => b.status === 'completed', 600_000, '续传完成')
  check(
    'B4c 续传后全部章节完成',
    done.chapters.filter((c) => c.status === 'done').length === 5
  )
}

// B5 两阶段配音：规划失败 → 规划成功 → 编辑音色 → 生成完成
{
  await setMode('garbage')
  const chapters = ['甲', '乙'].map((mark, i) => ({
    title: `失败重试第${i + 1}章-${runId}`,
    content: chapterText(`（重试${mark}）`),
  }))
  const created = await api('POST', '/create', {
    title: `失败重试书${runId}`,
    chapters,
    params: { ...bookParams, useLLM: true },
  })
  const bookId = created.json?.data?.bookId
  const initial = await api('GET', `/${bookId}`)
  check(
    'B5a AI 书创建后暂停等待音色规划',
    initial.json?.data?.status === 'paused',
    JSON.stringify(initial.json?.data?.status)
  )
  await api('POST', `/${bookId}/planVoices`)
  const failedPlan = await waitForBook(bookId, (b) => !!b.message, 120_000, '规划失败信息')
  check(
    'B5b 规划失败写入错误信息（AI 模式不会自动生成）',
    failedPlan.status === 'paused' && failedPlan.chapters.every((c) => c.status !== 'done'),
    JSON.stringify(failedPlan.message).slice(0, 120)
  )
  await setMode('normal')
  await api('POST', `/${bookId}/planVoices`)
  const planned = await waitForBook(
    bookId,
    (b) => (b.characterVoices?.length || 0) > 0,
    180_000,
    '角色音色规划完成'
  )
  check(
    'B5c 角色音色规划完成',
    (planned.characterVoices?.length || 0) >= 2,
    JSON.stringify(planned.characterVoices?.map((c) => c.character))
  )
  // 编辑角色音色：主角改为晓伊
  const edited = planned.characterVoices.map((c) =>
    c.character === '主角' ? { ...c, voice: 'zh-CN-XiaoyiNeural' } : { character: c.character, voice: c.voice }
  )
  const saved = await api('POST', `/${bookId}/characterVoices`, { characters: edited })
  const savedEntry = saved.json?.data?.find((c) => c.character === '主角')
  check(
    'B5d 编辑角色音色生效',
    saved.status === 200 && savedEntry?.voice === 'zh-CN-XiaoyiNeural',
    JSON.stringify(saved.json).slice(0, 160)
  )
  await api('POST', `/${bookId}/resume`)
  // Edge 偶发抖动可能产生失败章：允许一轮生成 + 一轮重试
  let done = await waitForBook(
    bookId,
    (b) => b.status === 'completed' || b.status === 'paused',
    300_000,
    '一轮生成'
  )
  if (done.status === 'paused') {
    await api('POST', `/${bookId}/retryFailed`)
    done = await waitForBook(bookId, (b) => b.status === 'completed', 300_000, '重试后完成')
  }
  check(
    'B5e 按确认的映射生成完成',
    done.chapters.filter((c) => c.status === 'done').length === 2
  )
  // B7 试听：返回有效 MP3（Edge 网络抖动时重试一次）
  let prev = await fetch(`${BASE}/${bookId}/character/preview?character=主角`, {
    signal: AbortSignal.timeout(60_000),
  })
  let buf = Buffer.from(await prev.arrayBuffer())
  if (!(prev.status === 200 && buf.length > 500 && buf[0] === 0xff)) {
    prev = await fetch(`${BASE}/${bookId}/character/preview?character=主角`, {
      signal: AbortSignal.timeout(60_000),
    })
    buf = Buffer.from(await prev.arrayBuffer())
  }
  check(
    'B7 角色音色试听返回有效 MP3',
    prev.status === 200 && buf.length > 500 && buf[0] === 0xff,
    `status=${prev.status} bytes=${buf.length}`
  )
}

// B6 重复创建被拦截
{
  const chapters = [{ title: '唯一章', content: chapterText('（重复）') }]
  const first = await api('POST', '/create', {
    title: `重复书${runId}`,
    chapters,
    params: bookParams,
    autostart: false,
  })
  const second = await api('POST', '/create', {
    title: `重复书${runId}`,
    chapters,
    params: bookParams,
    autostart: false,
  })
  check(
    'B6 重复创建返回明确错误',
    first.status === 200 && second.status === 400 && /已存在/.test(second.json?.message || ''),
    JSON.stringify(second.json).slice(0, 160)
  )
}

// B8 声音克隆：上传参考音频 → 编辑角色使用克隆音色 → 生成走克隆服务
{
  const { default: ffmpegPath } = await import('ffmpeg-static')
  const { execFileSync } = await import('node:child_process')
  const { readFileSync } = await import('node:fs')
  const tmpMp3 = 'D:/github/easyVoice/packages/backend/audio/.cache/e2e-silence.mp3'
  execFileSync(
    ffmpegPath,
    ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '1', '-b:a', '96k', tmpMp3],
    { stdio: 'ignore' }
  )
  const audioBytes = readFileSync(tmpMp3)
  await fetch(`${MOCK}/set-audio`, { method: 'POST', body: audioBytes })

  // 上传参考音频（mp3 → 后端转码 wav）
  const up = await fetch(`${VOICES_BASE}/custom`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: `E2E克隆音色${runId}`,
      contentBase64: audioBytes.toString('base64'),
      ext: '.mp3',
    }),
    signal: AbortSignal.timeout(120_000),
  })
  const upJson = await up.json().catch(() => null)
  const customVoiceId = upJson?.data?.voice
  check(
    'B8a 上传参考音频生成克隆音色',
    up.status === 200 && !!customVoiceId && customVoiceId.startsWith('custom-'),
    JSON.stringify(upJson).slice(0, 160)
  )

  // 保存克隆服务设置并创建 AI 书
  await fetch(`${SETTINGS_BASE}/clone`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      baseUrl: MOCK,
      language: 'zh',
      wavUrlPrefix: 'http://127.0.0.1:3001',
    }),
  })
  await setMode('normal')
  const created = await api('POST', '/create', {
    title: `克隆书${runId}`,
    chapters: [{ title: `克隆章-${runId}`, content: chapterText('（克隆）') }],
    params: { ...bookParams, useLLM: true },
  })
  const bookId = created.json?.data?.bookId
  // 触发角色音色规划，等待完成后把所有角色改为克隆音色
  await api('POST', `/${bookId}/planVoices`)
  await waitForBook(bookId, (b) => (b.characterVoices?.length || 0) > 0, 180_000, '规划完成')
  const planned = (await (await fetch(`${BASE}/${bookId}`)).json()).data
  const edited = planned.characterVoices.map((c) => ({ character: c.character, voice: customVoiceId }))
  await fetch(`${BASE}/${bookId}/characterVoices`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ characters: edited }),
  })
  await fetch(`${BASE}/${bookId}/resume`, { method: 'POST' })
  const done = await waitForBook(bookId, (b) => b.status === 'completed', 420_000, '克隆生成完成')
  check(
    'B8b 克隆音色生成完成',
    done.chapters.filter((c) => c.status === 'done').length === 1,
    JSON.stringify(done.chapters.map((c) => c.status))
  )
  // 克隆服务确实收到了携带参考 wav URL 的合成请求
  const reqLog = await (await fetch(`${MOCK}/audio-requests`)).json()
  const cloneReq = reqLog.requests.find((r) => String(r.voice || '').includes('/custom-voices/'))
  check('B8c 克隆服务收到携带参考音频的请求', !!cloneReq, JSON.stringify(reqLog).slice(0, 200))
  // 章节音频可下载
  const audio = await fetch(`${BASE}/${bookId}/chapter/0/audio`, { signal: AbortSignal.timeout(30_000) })
  const audioBuf = Buffer.from(await audio.arrayBuffer())
  check(
    'B8d 克隆章节音频可下载',
    audio.status === 200 && audioBuf.length > 0,
    `status=${audio.status} bytes=${audioBuf.length}`
  )
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
