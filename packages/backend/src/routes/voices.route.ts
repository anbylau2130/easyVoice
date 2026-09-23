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
  getVcInfoHandler,
  listOmniDesignsHandler,
  createOmniDesignHandler,
  deleteOmniDesignHandler,
  previewOmniDesignHandler,
  omniDesignSampleHandler,
} from '../controllers/voices.controller'

const router = Router()

// 音色转换资源（OpenVoice 参考音频 / RVC 模型 / OmniVoice 参考与设计声纹）
router.get('/vc-info', getVcInfoHandler)

router.get('/custom', listCustomVoicesHandler)
router.post('/custom', uploadCustomVoiceHandler)
router.post('/custom/:id/preview', previewCustomVoiceHandler)
router.delete('/custom/:id', deleteCustomVoiceHandler)

// 自定义 Edge 音色预设
router.get('/presets', listVoicePresetsHandler)
router.post('/presets', saveVoicePresetHandler)
router.post('/presets/preview', previewVoicePresetHandler)
router.delete('/presets/:id', deleteVoicePresetHandler)

// OmniVoice 音色设计（保存时按描述固化声纹为参考音频 omni-<名字>.wav）
router.get('/omni-designs', listOmniDesignsHandler)
router.post('/omni-designs', createOmniDesignHandler)
router.post('/omni-designs/delete', deleteOmniDesignHandler)
router.post('/omni-designs/preview', previewOmniDesignHandler)
router.post('/omni-designs/sample', omniDesignSampleHandler)

export default router
