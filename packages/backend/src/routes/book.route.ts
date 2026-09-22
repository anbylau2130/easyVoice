import { Router } from 'express'
import {
  parseBookHandler,
  createBookHandler,
  listBooksHandler,
  getBookHandler,
  pauseBookHandler,
  resumeBookHandler,
  retryFailedHandler,
  regenerateChapterHandler,
  deleteBookHandler,
  updateSelectionHandler,
  chapterAudioHandler,
  chapterSrtHandler,
  planVoicesHandler,
  stopPlanVoicesHandler,
  saveCharacterVoicesHandler,
  previewCharacterHandler,
} from '../controllers/book.controller'

const router = Router()

router.get('/list', listBooksHandler)
router.post('/parseBook', parseBookHandler)
router.post('/create', createBookHandler)
router.post('/:id/planVoices', planVoicesHandler)
router.post('/:id/planVoices/stop', stopPlanVoicesHandler)
router.post('/:id/characterVoices', saveCharacterVoicesHandler)
router.get('/:id/character/preview', previewCharacterHandler)
router.post('/:id/selection', updateSelectionHandler)
router.get('/:id', getBookHandler)
router.post('/:id/pause', pauseBookHandler)
router.post('/:id/resume', resumeBookHandler)
router.post('/:id/retryFailed', retryFailedHandler)
router.post('/:id/chapters/:index/regenerate', regenerateChapterHandler)
router.delete('/:id', deleteBookHandler)
router.get('/:id/chapter/:index/audio', chapterAudioHandler)
router.get('/:id/chapter/:index/srt', chapterSrtHandler)

export default router
