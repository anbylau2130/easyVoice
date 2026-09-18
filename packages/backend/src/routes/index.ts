import { Application } from 'express'
import ttsRoutes from './tts.route'
import bookRoutes from './book.route'
import settingsRoutes from './settings.route'
import voicesRoutes from './voices.route'
import history from 'connect-history-api-fallback'
import { healthHandler } from '../middleware/health.middleware'

export function setupRoutes(app: Application): void {
  app.use('/api/v1/tts', ttsRoutes)
  app.use('/api/v1/book', bookRoutes)
  app.use('/api/v1/settings', settingsRoutes)
  app.use('/api/v1/voices', voicesRoutes)
  app.use('/api/health', healthHandler)
  app.use(history())
}
