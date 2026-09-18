// tests/e2e/mock-llm-server.js
// 本地 mock OpenAI 兼容服务，用于 LLM 分段路径的端到端测试。
// 通过 POST /mode 切换返回行为（白名单校验，响应为静态内容，不回显请求）：
//   normal       返回覆盖全部文本的单角色分段（正确路径）
//   garbage      返回被截断的非法 JSON（模拟模型输出截断）
//   wrong-shape  返回不含分段数组的 JSON（模拟结构不兼容的模型）
//   missing-text 返回的分段全部缺 text 字段
//   dropped-text 只返回一半文本（触发覆盖率校验）
const http = require('http')

let mode = process.env.MOCK_MODE || 'normal'
const VOICE = 'zh-CN-YunxiNeural'
// 白名单：mode 只允许已知行为，非法值直接拒绝，绝不回显未验证的输入
const VALID_MODES = ['normal', 'garbage', 'wrong-shape', 'missing-text', 'dropped-text']
let storedAudio = null
const audioRequests = []

function extractText(prompt) {
  const markers = ['### 待处理内容', '### Content to be processed']
  for (const marker of markers) {
    const idx = prompt.lastIndexOf(marker)
    if (idx >= 0) return prompt.slice(idx + marker.length).trim()
  }
  return prompt.slice(-200)
}

function buildSegmentsForMode(text) {
  const segment = {
    name: VOICE,
    charactor: 'narration',
    style: 'cheerful',
    rate: '+0%',
    volume: '+0%',
    pitch: '+0Hz',
    text,
  }
  switch (mode) {
    case 'garbage':
      // 非法 JSON，模拟输出被截断
      return '{"segments": [{'
    case 'wrong-shape':
      return JSON.stringify({ foo: 'bar', note: 'no segments here' })
    case 'missing-text':
      return JSON.stringify({ segments: [{ name: VOICE, rate: '+0%' }] })
    case 'dropped-text':
      return JSON.stringify({
        segments: [{ ...segment, text: text.slice(0, Math.floor(text.length / 2)) }],
      })
    default:
      return JSON.stringify({ segments: [segment] })
  }
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { 'content-type': 'application/json' })
  res.end(body)
}

function buildChatCompletion(payload, content) {
  return JSON.stringify({
    id: 'mock-completion',
    object: 'chat.completion',
    created: Date.now(),
    model: payload.model,
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content },
      },
    ],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

function handleChatCompletions(req, res) {
  let body = ''
  req.on('data', (chunk) => (body += chunk))
  req.on('end', () => {
    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      sendJson(res, 400, '{"error":"invalid json"}')
      return
    }
    const userMessage = payload.messages?.find((m) => m.role === 'user')?.content || ''
    // 角色音色规划调用：返回固定的角色映射（normal 模式下）
    if (userMessage.includes('【角色音色规划】')) {
      if (mode === 'garbage') {
        sendJson(res, 200, buildChatCompletion(payload, '{"cha'))
        return
      }
      sendJson(
        res,
        200,
        buildChatCompletion(
          payload,
          JSON.stringify({
            characters: [
              { character: '旁白', gender: 'female', voice: 'zh-CN-YunxiNeural', description: 'narrator' },
              { character: '主角', gender: 'male', voice: 'zh-CN-YunxiNeural', description: 'main' },
            ],
          })
        )
      )
      return
    }
    const text = extractText(userMessage)
    sendJson(res, 200, buildChatCompletion(payload, buildSegmentsForMode(text)))
  })
}

// 模式切换：输入只与白名单比对，响应为固定字面量，内容不进入任何响应
function handleModeChange(req, res) {
  let raw = ''
  req.on('data', (chunk) => (raw += chunk))
  req.on('end', () => {
    const requested = raw.trim() || 'normal'
    if (VALID_MODES.includes(requested)) {
      mode = requested
    }
    if (mode !== requested) {
      sendJson(res, 400, '{"error":"invalid mode"}')
    } else {
      sendJson(res, 200, '{"ok":true}')
    }
  })
}

const server = http.createServer((req, res) => {
  // 克隆 TTS 合成端点（OpenAI 兼容 /audio/speech）：返回预置的有效 MP3，并记录请求
  if (req.method === 'POST' && req.url.endsWith('/audio/speech')) {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}')
      } catch {
        body = {}
      }
      audioRequests.push({ voice: body.voice, language: body.language })
      if (!storedAudio) {
        res.writeHead(503, { 'content-type': 'application/json' })
        res.end('{"error":"no audio set"}')
        return
      }
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      res.end(storedAudio)
    })
    return
  }
  // 上传预置音频（供 /audio/speech 返回）
  if (req.method === 'POST' && req.url === '/set-audio') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      storedAudio = Buffer.concat(chunks)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ bytes: storedAudio.length }))
    })
    return
  }
  if (req.method === 'GET' && req.url === '/audio-requests') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ count: audioRequests.length, requests: audioRequests }))
    return
  }
  if (req.method === 'POST' && req.url === '/mode') {
    handleModeChange(req, res)
    return
  }
  if (req.method === 'POST' && req.url.endsWith('/chat/completions')) {
    handleChatCompletions(req, res)
    return
  }
  res.writeHead(404)
  res.end()
})

const PORT = process.env.MOCK_PORT || 9333
server.listen(PORT, '127.0.0.1', () =>
  console.log(`mock LLM server listening on 127.0.0.1:${PORT} (mode=${mode})`)
)
