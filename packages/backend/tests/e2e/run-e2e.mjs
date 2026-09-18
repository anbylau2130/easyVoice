// tests/e2e/run-e2e.mjs
// 端到端测试：需要先启动 mock LLM 与后端
//   1) node tests/e2e/mock-llm-server.js
//   2) OPENAI_BASE_URL=http://127.0.0.1:9333/v1 OPENAI_API_KEY=e2e MODEL_NAME=mock \
//      DIRECT_GEN_LIMIT=2000 node dist/server.js   (PATH 中需有 ffmpeg)
// 运行: node tests/e2e/run-e2e.mjs
const BASE = process.env.E2E_BASE_URL || 'http://localhost:3000/api/v1/tts'
const MOCK = process.env.E2E_MOCK_URL || 'http://127.0.0.1:9333'
// 每个请求独立超时：共享 signal 会从脚本启动起算，慢用例会连累后续全部请求
const TIMEOUT_MS = 180_000

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

async function setMode(mode) {
  const res = await fetch(`${MOCK}/mode`, {
    method: 'POST',
    body: mode,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`setMode(${mode}) failed`)
}

function isMp3(buf) {
  return buf && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0
}

/**
 * 消费流式接口。三种结局：
 * - 音频流完整结束: { ok: true, bytes }
 * - 连接中断(后端失败时主动断开): { ok: false, errored: true }
 * - JSON 响应(缓存命中/失败): { ok, json }
 */
async function stream(body) {
  let res
  try {
    res = await fetch(`${BASE}/createStream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
  } catch (err) {
    // 后端在发出任何字节前中断（连接被切断）= 失败可见信号
    return { ok: false, errored: true, bytes: 0, fetchError: String(err?.cause || err) }
  }
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const json = await res.json().catch(() => null)
    return { ok: res.status === 200 && json?.success && !!json?.data?.audio, json, bytes: 0 }
  }
  const reader = res.body.getReader()
  const chunks = []
  let errored = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
  } catch {
    errored = true
  }
  const bytes = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const head = Buffer.from(chunks[0] || []).subarray(0, 2)
  return { ok: !errored && res.status === 200, errored, bytes, head }
}

const edgeBody = (text) => ({
  text,
  voice: 'zh-CN-YunxiNeural',
  rate: '+0%',
  volume: '+0%',
  pitch: '+0Hz',
})
const llmBody = (text) => ({ ...edgeBody(text), useLLM: true })

const zhLongText =
  '徐凤年翻身上马，回头看了眼那座破败的山神庙，策马向着北凉的方向奔去。风雪越来越大，他的眉头也越皱越紧。'.repeat(
    10
  )
const runId = Date.now() // 每次运行用唯一文本，避开音频缓存

console.log('=== EasyVoice E2E ===')

// T1 声音列表
{
  const res = await fetch(`${BASE}/voiceList`, {
    method: 'GET',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const json = await res.json()
  check('T1 voiceList 返回声音列表', res.status === 200 && Array.isArray(json.data) && json.data.length > 0)
}

// T2 短文本 Edge 流（固定文本，顺带验证缓存命中路径）
{
  const r = await stream(edgeBody('端到端测试短文本。今天天气不错。'))
  check('T2 短文本 Edge 流式合成（含缓存命中）', r.ok && (r.bytes > 1000 || !!r.json), JSON.stringify(r).slice(0, 160))
}

// T3 长文本 Edge 多段流式合成
{
  let r = await stream(edgeBody(zhLongText + runId))
  if (!r.ok) {
    console.log('  (Edge 偶发中断，重试一次)')
    r = await stream(edgeBody(zhLongText + runId + 'b'))
  }
  check('T3 长文本 Edge 多段流式合成', r.ok && r.bytes > 10000 && isMp3(r.head), JSON.stringify(r).slice(0, 160))
}

// T4 长文本 LLM(AI 配音) 流式合成 —— 本次修复的核心路径
{
  await setMode('normal')
  const r = await stream(llmBody(zhLongText + runId + '-llm'))
  check('T4 长文本 LLM 流式合成', r.ok && r.bytes > 10000 && isMp3(r.head), JSON.stringify(r).slice(0, 160))
}

// T5 模型返回非法 JSON（截断）→ 必须失败可见，不允许静默成功
{
  await setMode('garbage')
  const r = await stream(llmBody(zhLongText + runId + '-garbage'))
  check('T5 模型输出非法 JSON → 流中断可见失败', !r.ok, JSON.stringify(r).slice(0, 160))
}

// T6 模型返回不含分段数组的结构 → 重试后失败
{
  await setMode('wrong-shape')
  const r = await stream(llmBody(zhLongText + runId + '-shape'))
  check('T6 模型结构不兼容 → 重试后失败', !r.ok, JSON.stringify(r).slice(0, 160))
}

// T7 分段全部缺 text → 失败
{
  await setMode('missing-text')
  const r = await stream(llmBody(zhLongText + runId + '-missing'))
  check('T7 分段缺 text → 失败', !r.ok, JSON.stringify(r).slice(0, 160))
}

// T8 分段遗漏文本（覆盖率不足）→ 失败
{
  await setMode('dropped-text')
  const r = await stream(llmBody(zhLongText + runId + '-dropped'))
  check('T8 分段遗漏文本 → 覆盖率校验失败', !r.ok, JSON.stringify(r).slice(0, 160))
}

// T9 连续失败后服务仍存活，恢复正常后继续合成
{
  await setMode('normal')
  const health = await fetch(`${BASE}/voiceList`, {
    method: 'GET',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  check('T9a 连续失败后服务仍存活', health.status === 200)
  const r0 = await stream(edgeBody('恢复测试。服务仍然可用。' + runId))
  const r = r0.ok ? r0 : await stream(edgeBody('恢复测试。服务仍然可用。' + runId + 'b'))
  check('T9b 恢复后仍可正常合成', r.ok && r.bytes > 1000, JSON.stringify(r).slice(0, 160))
}

// T10 非流式长文本生成（ffmpeg 拼接 mp3 + srt），DIRECT_GEN_LIMIT 需大于文本长度
{
  const res = await fetch(`${BASE}/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(edgeBody(zhLongText + runId + '-gen')),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const json = await res.json()
  check(
    'T10 非流式长文本生成（mp3+srt+拼接）',
    res.status === 200 && !!json?.data?.audio && !!json?.data?.srt && !json?.data?.partial,
    JSON.stringify(json).slice(0, 200)
  )
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`)
process.exit(fail ? 1 : 0)
