import ffmpeg from 'fluent-ffmpeg'
import ffmpegStatic from 'ffmpeg-static'

// FFMPEG_PATH 环境变量优先（Docker 内使用系统 ffmpeg）；
// 本地开发回退到 ffmpeg-static 自带二进制（跨平台免安装）
if (process.env.FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH)
} else if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic)
}

export default ffmpeg
