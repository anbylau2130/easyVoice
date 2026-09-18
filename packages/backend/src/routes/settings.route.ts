import { Router } from 'express'
import {
  getLlmSettingsHandler,
  saveLlmSettingsHandler,
  getCloneSettingsHandler,
  saveCloneSettingsHandler,
  testCloneHandler,
} from '../controllers/settings.controller'

const router = Router()

router.get('/llm', getLlmSettingsHandler)
router.post('/llm', saveLlmSettingsHandler)
router.get('/clone', getCloneSettingsHandler)
router.post('/clone', saveCloneSettingsHandler)
router.post('/clone/test', testCloneHandler)

export default router
