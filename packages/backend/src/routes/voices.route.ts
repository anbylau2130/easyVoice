import { Router } from 'express'
import {
  listCustomVoicesHandler,
  uploadCustomVoiceHandler,
  deleteCustomVoiceHandler,
} from '../controllers/voices.controller'

const router = Router()

router.get('/custom', listCustomVoicesHandler)
router.post('/custom', uploadCustomVoiceHandler)
router.delete('/custom/:id', deleteCustomVoiceHandler)

export default router
