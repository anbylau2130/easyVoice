// tests/e2e/generate-driver.mjs
// 有声书批量生成监控器：按顺序生成多本书，自动重试失败章节，实时输出进度
// 用法: node tests/e2e/generate-driver.mjs [bookId1 bookId2 ...]
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000/api/v1/book'
const MOCK = process.env.E2E_MOCK_URL || 'http://127.0.0.1:9333'
const MAX_ROUNDS = 8 // 每本书最多重试轮数

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getBook(id) {
  const res = await fetch(`${BASE}/${id}`, { signal: AbortSignal.timeout(30_000) })
  return (await res.json()).data
}

async function post(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', signal: AbortSignal.timeout(30_000) })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function setMode(mode) {
  await fetch(`${MOCK}/mode`, { method: 'POST', body: mode }).catch(() => {})
}

function progressLine(book) {
  const done = book.chapters.filter((c) => c.status === 'done').length
  const failed = book.chapters.filter((c) => c.status === 'failed').length
  const processing = book.chapters.find((c) => c.status === 'processing')
  const elapsed = processing?.startedAt
    ? Math.round((Date.now() - new Date(processing.startedAt).getTime()) / 1000) + 's'
    : '-'
  return `done=${done} failed=${failed} 当前: 章${(processing?.index ?? -1) + 1}(片段${processing?.progress ?? 0}%, ${elapsed})`
}

const bookIds = process.argv.slice(2)
if (!bookIds.length) {
  console.error('用法: node generate-driver.mjs <bookId...>')
  process.exit(1)
}

for (const bookId of bookIds) {
  console.log(`\n======== 开始生成: ${bookId} ========`)
  // 若该书正在生成（其他实例/用户启动），直接进入监控，不重复 resume
  let current = (await (await fetch(`${BASE}/${bookId}`)).json()).data
  const alreadyRunning = current?.status === 'running'
  if (!alreadyRunning) {
    // 触发角色音色规划（若已规划则接口报错，忽略）
    const planRes = await fetch(`${BASE}/${bookId}/planVoices`, { method: 'POST' })
    if (planRes.status === 400) {
      const err = await planRes.json().catch(() => ({}))
      console.log(`  跳过规划: ${err.message || ''}`)
    } else {
      console.log('  角色音色规划已启动…')
    }
    // 等待规划完成（characterVoices 出现）
    const planDeadline = Date.now() + 300_000
    let planned = false
    while (Date.now() < planDeadline) {
      const d = (await (await fetch(`${BASE}/${bookId}`)).json()).data
      if (d.characterVoices?.length) {
        planned = true
        console.log(`  规划完成: ${d.characterVoices.map((c) => c.character).join('、')}`)
        break
      }
      if (d.message) {
        console.log(`  规划失败: ${d.message}`)
        break
      }
      await sleep(3000)
    }
    if (!planned) {
      console.log(`  ✗ ${bookId} 规划未完成，跳过该书（保留暂停状态可手动续传）`)
      continue
    }
    // 单本锁被其他书占用时：排队等待（最多 24 小时）
    const queueDeadline = Date.now() + 24 * 3600_000
    while (Date.now() < queueDeadline) {
      const list = (await (await fetch(`${BASE}/list`)).json()).data
      const active = list.find((b) => b.status === 'running')
      if (!active) break
      console.log(`  等待锁释放（${active.title.slice(0, 20)} 生成中）…`)
      await sleep(60_000)
    }
    const resume = await post(`/${bookId}/resume`)
    if (resume.status !== 200) {
      console.log(`  ✗ 启动生成失败: ${resume.json?.message}`)
      continue
    }
  }

  // 生成 + 自动重试循环
  let completed = false
  for (let round = 0; round < MAX_ROUNDS && !completed; round++) {
    // 等待状态变化（running → completed/paused），最长相邻书排队时间
    const deadline = Date.now() + 24 * 3600_000
    let book
    while (Date.now() < deadline) {
      book = (await (await fetch(`${BASE}/${bookId}`)).json()).data
      if (book.status !== 'running') break
      await sleep(5000)
    }
    if (!book) break
    if (book.status === 'completed') {
      completed = true
      break
    }
    // paused：存在失败章节，自动重试一轮
    const failed = book.chapters.filter((c) => c.status === 'failed')
    console.log(`  第 ${round + 1} 轮结束: paused, 失败章节 ${failed.length} 个，自动重试…`)
    for (const c of failed) console.log(`    - 章${c.index + 1}: ${c.error || ''}`.slice(0, 120))
    await post(`/${bookId}/retryFailed`)
  }
  const final = (await (await fetch(`${BASE}/${bookId}`)).json()).data
  const done = final.chapters.filter((c) => c.status === 'done').length
  const failedList = final.chapters.filter((c) => c.status === 'failed')
  console.log(
    `  ► ${bookId} 最终: ${final.status}, done=${done}/${final.chapters.filter((c) => c.status !== 'skipped').length}` +
      (failedList.length ? `, 仍有失败: ${failedList.map((c) => '章' + (c.index + 1)).join(',')}` : '')
  )
  completed = final.status === 'completed'
  if (!completed) {
    // 交还控制权前稍等，让下一轮继续
    console.log('  （未全部完成，driver 继续重试该书）')
    bookIds.push(bookId) // 排到队尾再试
  }
}

console.log('\n全部书籍处理完毕')
