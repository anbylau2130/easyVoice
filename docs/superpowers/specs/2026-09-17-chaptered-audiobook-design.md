# 有声书分章节生成 + EPUB 支持 设计文档

日期：2026-09-17
状态：已实施

## 目标

1. 支持上传 **EPUB**（当前仅 txt）并解析章节
2. 长文本按**章节**切分，逐章生成音频（每章一个 mp3 + srt）
3. 支持**断点续传**：异常崩溃、进程重启、手动暂停后，从第一个未完成章节继续

## 方案选择

- **采纳**：后端新增 book 服务；每章调用现有 `generateTTS`（非流式）管线，复用其分段、并发限制、缓存、重试、覆盖率校验、partial 标记；章节状态持久化到磁盘。
- 否决：前端切章逐章调 `/createStream`——状态存浏览器，关页即丢，不满足续传。
- 否决：Redis/BullMQ 任务队列——单机 Docker 部署过度设计。

## 数据模型

`audio/books/<bookId>/book.json`：

```jsonc
{
  "id": "book-<md5>",
  "title": "书名",
  "status": "running | paused | completed",   // 书级状态
  "params": { "voice": "...", "rate": "+0%", "pitch": "+0Hz", "volume": "+0%", "useLLM": false },
  "chapters": [
    {
      "index": 0,
      "title": "第一章",
      "charCount": 1234,
      "status": "pending | processing | done | failed | skipped",
      "audioFile": "chapters/0.mp3",     // 相对书目录
      "srtFile": "chapters/0.srt",
      "error": null
    }
  ],
  "createdAt": "...", "updatedAt": "..."
}
```

bookId = `book-` + md5(title + 各章 title/字数 + 参数)（同书重复创建可复用）。

## 章节切分

- **EPUB**（后端 adm-zip）：container.xml → OPF → spine 顺序读 XHTML → 去标签 + 实体解码 → 每个 spine 文档为一章；连续短章（<200 字）合并入前一章；全书无正文则报错。
- **TXT**：正则识别章节标题（`第X章/节/回/卷`、`Chapter N`、`序章/楔子/引子/ prologue` 等），标题行到下一标题行之间为一章；无任何标记且总长 > 5000 时按 ~4000 字在句子边界兜底切分；否则整本一章。
- **编码**：txt 优先 UTF-8 解码，若 replacement 字符比例异常则回退 GBK。

## API（挂载 `/api/v1/book`）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/parseBook` | `{filename, contentBase64}` → `{title, chapters:[{title, content}]}`（只解析不创建任务） |
| POST | `/create` | `{title, chapters, params, autostart?}` → `{bookId}`；`params` 含 voice/rate/pitch/volume/useLLM |
| GET | `/list` | 全部书（id、title、status、进度） |
| GET | `/:id` | 书详情（含逐章状态） |
| POST | `/:id/pause` | 暂停：当前章完成后停止（章节边界粒度） |
| POST | `/:id/resume` | 续传：processing/failed/pending 章按序重跑，done 跳过 |
| POST | `/:id/retryFailed` | 仅重跑 failed 章 |
| GET | `/:id/chapter/:index/audio` | 章节音频流（播放/下载）；`.srt` 同理 |

## 生成循环

- 全局单本锁：同一时刻只跑一本，`create/resume` 遇占用报错提示。
- 逐章：`processing` → 调 `generateTTS({...params, text: 章内容})` → 产物移动到 `books/<id>/chapters/<index>.mp3|.srt` → `done`。
- 单章失败：标记 `failed` + 错误信息，**继续下一章**（不等失败章）；全部章节处理完后若存在 failed → 书状态 `paused`（UI 提示可重试）。
- `pause`：置内存标志，当前章完成后退出循环 → `paused`。
- 进程重启：启动时扫描所有 `status==='running'` 的书 → 置 `paused`（`processing` 章重置为 `pending`），用户手动续传。

## 前端（`/book` 路由 + Footer 导航项）

1. 上传区（.epub/.txt，FileReader → base64）→ 调 parseBook → 书名（默认文件名）+ 章节表格（勾选、标题、字数）
2. 语音配置：语言 + 声音下拉 + 语速/音调/音量 + 模式（预设声音 / AI 配音，AI 走服务端 .env 配置）
3. 创建后进度视图：总进度条 + 章节列表（状态 tag、完成后播放/下载）+ 暂停/继续/重试失败 按钮 + 2s 轮询
4. 书籍列表：历史书一键载入进度视图（含续传入口）

## 测试

- 单测：txt 切章（多标记格式/无标记兜底）、epub 解析（测试内用 adm-zip 构造最小 epub fixture）、book 状态机纯函数
- E2E（扩展 run-e2e.mjs）：创建 3 章书 → 轮询至 completed → 逐章下载校验 MP3；pause→resume 恢复；mock 模型故障 → failed 章 → 修复后 retryFailed → completed
