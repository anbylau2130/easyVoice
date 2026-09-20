import { Router } from 'express'
import {
  listCustomVoicesHandler,
  uploadCustomVoiceHandler,
  deleteCustomVoiceHandler,
  previewCustomVoiceHandler,
  listVoicePresetsHandler,
  saveVoicePresetHandler,
  deleteVoicePresetHandler,
  previewVoicePresetHandler,
} from '../controllers/voices.controller'

const router = Router()

router.get('/custom', listCustomVoicesHandler)
router.post('/custom', uploadCustomVoiceHandler)
router.post('/custom/:id/preview', previewCustomVoiceHandler)
router.delete('/custom/:id', deleteCustomVoiceHandler)

// 自定义 Edge 音色预设
router.get('/presets', listVoicePresetsHandler)
router.post('/presets', saveVoicePresetHandler)
router.post('/presets/preview', previewVoicePresetHandler)
router.delete('/presets/:id', deleteVoicePresetHandler)

export default router
