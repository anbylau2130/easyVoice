import { createApp } from './app'
import { AUDIO_DIR, PUBLIC_DIR, RATE_LIMIT, RATE_LIMIT_WINDOW, PORT } from './config'
import { ttsPluginManager } from './tts/pluginManager'
import { initBookService } from './services/book/book.service'
import { initLlmSettings } from './services/settings.service'
import { logger } from './utils/logger'

// 兜底：单个任务的异步失败不允许击垮整个进程（否则所有进行中的流都会被掐断）
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection:', reason instanceof Error ? reason.stack : reason)
})

const app = createApp({
  isDev: process.env.NODE_ENV === 'development',
  rateLimit: RATE_LIMIT,
  rateLimitWindow: RATE_LIMIT_WINDOW,
  audioDir: AUDIO_DIR,
  publicDir: PUBLIC_DIR,
})

app.listen(PORT, async () => {
  await ttsPluginManager.initializeEngines()
  // 上次进程中断时处于生成中的有声书，纠正为可续传状态
  await initBookService()
  // 恢复页面上保存过的 LLM 配置（优先于 .env）
  await initLlmSettings()
  console.log(`Server running on port ${PORT}`)
})
