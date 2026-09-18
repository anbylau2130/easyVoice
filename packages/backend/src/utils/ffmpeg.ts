import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'

// 统一使用 ffmpeg-static 自带的二进制（跨平台免安装），
// 避免依赖系统 PATH 里是否装了 ffmpeg（Windows/Mac 本地运行常见缺失）
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic)
}

export default ffmpeg
