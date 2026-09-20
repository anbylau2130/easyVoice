import { fetcher } from './request'

/**
 * 克隆 TTS 服务请求统一出口。
 * 克隆服务地址由用户在设置页配置（自部署单用户工具，服务通常运行在本机/局域网），
 * 所有发往该服务的请求必须经由本函数发出：出口处做最终安全校验，
 * 与调用方的入口校验（clone-tts.service 的 validateCloneBaseUrl）构成双重防御。
 */

/** 私网/环回地址识别（IPv4 私网段、localhost、Docker 宿主机别名、IPv6 环回） */
const PRIVATE_HOST_PATTERN =
  /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$|\[::1\]$|host\.docker\.internal$)/i

function assertSafeCloneTarget(target: URL): void {
  // 协议 allowlist：仅 http/https
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error('仅支持 http/https 协议')
  }
  // 始终拒绝云元数据地址（SSRF 防护）
  if (target.hostname === '169.254.169.254') {
    throw new Error('不允许的地址')
  }
  // 私网地址默认放行（核心场景：克隆服务跑在本机/局域网）；TTS_CLONE_STRICT=1 时严格封禁
  if (process.env.TTS_CLONE_STRICT === '1' && PRIVATE_HOST_PATTERN.test(target.hostname)) {
    throw new Error('严格模式下不允许访问内网地址（TTS_CLONE_STRICT=1）')
  }
}

/** POST {target.origin}/tts_to_audio/ —— target 必须是已通过 validateCloneBaseUrl 校验的 URL */
export async function postToCloneService(
  target: URL,
  body: Record<string, unknown>,
  config: { responseType: 'stream' | 'arraybuffer'; timeout: number }
) {
  assertSafeCloneTarget(target)
  return fetcher.post(`${target.origin}/tts_to_audio/`, body, config)
}
