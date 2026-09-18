<template>
  <div class="book-container">
    <header class="header">
      <h1 class="title">有声书工坊 📚</h1>
      <p class="subtitle">上传 EPUB / TXT，分章节生成有声书，支持暂停续传</p>
    </header>

    <!-- AI 模型配置 -->
    <section class="section">
      <div class="settings-head" @click="settingsOpen = !settingsOpen">
        <h2 class="section-title">AI 模型配置</h2>
        <el-tag :type="llmApiKeyConfigured ? 'success' : 'info'" size="small">
          {{ llmApiKeyConfigured ? '已配置' : '未配置' }}
        </el-tag>
        <span class="settings-toggle">{{ settingsOpen ? '收起 ▲' : '展开 ▼' }}</span>
      </div>
      <template v-if="settingsOpen">
        <p class="settings-tip">
          配置 OpenAI 兼容接口（供 AI 智能配音使用）。保存后立即生效并持久化，无需重启服务；API Key
          留空表示保持当前值不变。
        </p>
        <div class="config-grid">
          <div class="config-item">
            <label>Base URL</label>
            <el-input v-model="llmForm.baseUrl" placeholder="如 https://api.openai.com/v1" />
          </div>
          <div class="config-item">
            <label>模型名称</label>
            <el-input v-model="llmForm.model" placeholder="如 gpt-4o-mini / deepseek-chat" />
          </div>
          <div class="config-item">
            <label>API Key</label>
            <el-input
              v-model="llmForm.apiKey"
              type="password"
              show-password
              :placeholder="llmApiKeyConfigured ? '已配置（留空保持不变）' : 'sk-...'"
            />
          </div>
        </div>
        <div class="settings-actions">
          <el-button type="primary" :loading="savingLlm" @click="handleSaveLlmSettings">
            保存配置
          </el-button>
        </div>
      </template>
    </section>

    <!-- 自定义音色（声音克隆） -->
    <section class="section">
      <div class="settings-head" @click="cloneOpen = !cloneOpen">
        <h2 class="section-title">🎙️ 自定义音色（声音克隆）</h2>
        <el-tag :type="customVoices.length ? 'success' : 'info'" size="small">
          {{ customVoices.length ? `已有 ${customVoices.length} 个` : '未上传' }}
        </el-tag>
        <span class="settings-toggle">{{ cloneOpen ? '收起 ▲' : '展开 ▼' }}</span>
      </div>
      <template v-if="cloneOpen">
        <p class="settings-tip">
          上传一段清晰的语音（wav/mp3 等，建议 1-5 分钟、单一说话人），AI
          将克隆该音色用于朗读。需要在本机运行声音克隆服务（如
          xtts-api-server），并在下方配置服务地址。克隆音色合成速度取决于硬件，无 GPU 时较慢。
        </p>
        <div class="config-grid">
          <div class="config-item">
            <label>克隆服务地址</label>
            <el-input v-model="cloneForm.baseUrl" placeholder="如 http://127.0.0.1:8020" />
          </div>
          <div class="config-item">
            <label>合成语言</label>
            <el-input v-model="cloneForm.language" placeholder="zh" />
          </div>
          <div class="config-item">
            <label>参考音频地址前缀</label>
            <el-input v-model="cloneForm.wavUrlPrefix" placeholder="http://127.0.0.1:3000" />
          </div>
        </div>
        <div class="settings-actions">
          <el-button type="primary" :loading="savingClone" @click="handleSaveCloneSettings">
            保存克隆服务配置
          </el-button>
        </div>

        <div class="upload-voice-row">
          <el-input
            v-model="newVoiceName"
            placeholder="音色名称（如：我的声音）"
            maxlength="30"
            style="width: 220px"
          />
          <el-upload
            :auto-upload="false"
            :show-file-list="false"
            accept=".wav,.mp3,.m4a,.flac,.ogg"
            :on-change="handleUploadVoice"
          >
            <el-button :loading="voiceUploading">选择音频并上传</el-button>
          </el-upload>
        </div>
        <el-alert v-if="uploadError" :title="uploadError" type="error" :closable="false" class="failed-alert" />

        <el-table v-if="customVoices.length" :data="customVoices" size="small" max-height="220">
          <el-table-column prop="name" label="名称" width="180" />
          <el-table-column prop="voice" label="音色 ID" min-width="200" show-overflow-tooltip />
          <el-table-column label="操作" width="90">
            <template #default="{ row }">
              <el-button type="danger" link @click="handleDeleteVoice(row.id)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </section>

    <!-- 书籍列表 -->
    <section v-if="books.length" class="section">
      <h2 class="section-title">我的有声书</h2>
      <el-table :data="books" class="book-table" size="large">
        <el-table-column prop="title" label="书名" min-width="180" show-overflow-tooltip />
        <el-table-column label="进度" width="140">
          <template #default="{ row }">{{ row.done }} / {{ row.total }} 章</template>
        </el-table-column>
        <el-table-column label="状态" width="120">
          <template #default="{ row }">
            <el-tag :type="bookStatusType(row.status)">{{ bookStatusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="失败" width="80">
          <template #default="{ row }">
            <el-tag v-if="row.failed" type="danger" size="small">{{ row.failed }}</el-tag>
            <span v-else>-</span>
          </template>
        </el-table-column>
        <el-table-column label="文件目录" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <span class="dir-text">{{ row.dir }}</span>
            <el-button type="primary" link size="small" @click="copyDir(row.dir)">复制</el-button>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="140">
          <template #default="{ row }">
            <el-button type="primary" link @click="openBook(row.id)">打开</el-button>
            <el-button type="danger" link @click="handleDeleteBook(row.id, row.title)">
              删除
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <!-- 上传与配置 -->
    <section v-if="!bookId" class="section">
      <h2 class="section-title">新建有声书</h2>
      <el-upload
        class="upload-box"
        drag
        :auto-upload="false"
        :show-file-list="false"
        accept=".epub,.txt"
        :on-change="handleFileChange"
      >
        <div class="upload-inner">
          <p class="upload-main">点击或拖拽 EPUB / TXT 文件到此处</p>
          <p class="upload-sub">EPUB 将按目录章节解析；TXT 按章节标题自动切分</p>
        </div>
      </el-upload>
      <p v-if="parseState.parsing" class="parse-tip">正在解析书籍…</p>
      <el-alert v-if="parseState.error" :title="parseState.error" type="error" :closable="false" />

      <template v-if="parsedBook">
        <div class="config-grid">
          <div class="config-item">
            <label>书名</label>
            <el-input v-model="bookTitle" maxlength="100" placeholder="书名" />
          </div>
          <div class="config-item">
            <label>语言</label>
            <el-select v-model="selectedLanguage" @change="filterVoiceOptions">
              <el-option v-for="lang in languages" :key="lang.code" :label="lang.name" :value="lang.code" />
            </el-select>
          </div>
          <div class="config-item">
            <label>{{ voiceMode === 'llm' ? '旁白音色（其余角色由 AI 分配）' : '声音' }}</label>
            <el-select v-model="selectedVoice" filterable>
              <el-option
                v-for="voice in filteredVoices"
                :key="voice.Name"
                :label="voice.cnName ? `${voice.cnName} (${voice.Name})` : voice.Name"
                :value="voice.Name"
              />
            </el-select>
          </div>
          <div class="config-item">
            <label>配音模式</label>
            <el-radio-group v-model="voiceMode">
              <el-radio value="preset">预设声音</el-radio>
              <el-radio value="llm">AI 智能配音</el-radio>
            </el-radio-group>
          </div>
          <div v-if="voiceMode === 'preset'" class="config-item sliders">
            <label>语速 {{ formatPercent(rate) }}</label>
            <el-slider v-model="rate" :min="-50" :max="100" :step="10" />
            <label>音调 {{ formatHz(pitch) }}</label>
            <el-slider v-model="pitch" :min="-20" :max="20" :step="2" />
            <label>音量 {{ formatPercent(volume) }}</label>
            <el-slider v-model="volume" :min="-50" :max="100" :step="10" />
          </div>
          <div v-if="voiceMode === 'llm'" class="config-item llm-tip">
            <el-alert
              title="AI 配音使用上方「AI 模型配置」中的模型（未配置时回落到服务端 .env），逐章为内容智能分配角色与语气"
              type="info"
              :closable="false"
            />
          </div>
        </div>

        <div class="chapter-head">
          <h3>章节预览（共 {{ parsedBook.chapters.length }} 章）</h3>
          <el-button link type="primary" @click="toggleAllChapters">
            {{ allSelected ? '全不选' : '全选' }}
          </el-button>
        </div>
        <el-table
          ref="chapterTableRef"
          :data="pagedChapters"
          max-height="360"
          class="chapter-table"
          row-key="key"
          @selection-change="handleSelectionChange"
        >
          <el-table-column type="selection" width="46" reserve-selection />
          <el-table-column label="#" width="70">
            <template #default="{ $index }">{{ chapterOffset + $index + 1 }}</template>
          </el-table-column>
          <el-table-column prop="title" label="章节标题" min-width="220" show-overflow-tooltip />
          <el-table-column label="字数" width="110">
            <template #default="{ row }">{{ row.content.length }}</template>
          </el-table-column>
        </el-table>
        <el-pagination
          v-if="parsedBook.chapters.length > chapterPageSize"
          layout="prev, pager, next, total"
          :total="parsedBook.chapters.length"
          :page-size="chapterPageSize"
          v-model:current-page="chapterPage"
        />

        <div class="create-actions">
          <el-button
            type="primary"
            size="large"
            round
            :disabled="!selectedChapters.length"
            :loading="creating"
            @click="handleCreate"
          >
            <template v-if="voiceMode === 'llm'">
              创建有声书（{{ selectedChapters.length }} 章）→ 规划角色音色
            </template>
            <template v-else>开始生成（{{ selectedChapters.length }} 章）</template>
          </el-button>
        </div>
      </template>
    </section>

    <!-- 生成进度 -->
    <section v-else class="section">
      <h2 class="section-title">{{ bookDetail?.title || '有声书' }}</h2>
      <el-steps
        v-if="bookDetail?.params.useLLM"
        :active="aiStep"
        align-center
        finish-status="success"
        class="ai-steps"
      >
        <el-step title="规划角色音色" description="AI 通读全书按性格分配" />
        <el-step title="试听 / 编辑确认" description="可调整每个角色的音色" />
        <el-step title="生成有声书" description="逐章生成音频" />
      </el-steps>
      <div class="progress-head" v-if="bookDetail">
        <el-tag :type="bookStatusType(bookDetail.status)" size="large">
          {{ bookStatusText(bookDetail.status) }}
        </el-tag>
        <el-progress
          class="progress-bar"
          :percentage="progressPercent"
          :stroke-width="14"
          striped
          :striped-flow="bookDetail.status === 'running'"
        />
        <span class="progress-text">{{ doneCount }} / {{ totalCount }} 章</span>
      </div>
      <div v-if="currentProcessing" class="current-line">
        <LoaderCircle class="spin-icon" :size="16" />
        <span>
          正在生成：第 {{ currentProcessing.index + 1 }} 章「{{ currentProcessing.title }}」
          <template v-if="currentProcessing.progress != null">
            · 片段进度 {{ currentProcessing.progress }}%
          </template>
          · 已用时 {{ elapsedText(currentProcessing.startedAt) }}
          · 服务最近活动 {{ lastActivityText }}
        </span>
      </div>
      <el-alert
        v-if="bookDetail?.message"
        :title="bookDetail.message"
        type="error"
        :closable="false"
        class="failed-alert"
      />
      <div v-if="bookDetail?.planning" class="current-line">
        <LoaderCircle class="spin-icon" :size="16" />
        <span>AI 正在通读全书，按角色性格规划音色…（约 1-3 分钟，期间尚无片段进度属正常）</span>
      </div>
      <div
        v-else-if="bookDetail?.status === 'running' && !currentProcessing"
        class="current-line"
      >
        <LoaderCircle class="spin-icon" :size="16" />
        <span>正在准备生成… 服务最近活动 {{ lastActivityText }}</span>
      </div>
      <el-alert
        v-if="bookDetail && failedCount"
        :title="`${failedCount} 个章节生成失败，可点击「重试失败章节」`"
        type="error"
        :closable="false"
        class="failed-alert"
      />
      <el-alert
        v-if="bookDetail?.params.useLLM && !hasCharacterVoices && !bookDetail?.planning"
        title="AI 配音第一步：点击「AI 规划角色音色」，AI 将通读全书按角色性格分配音色；试听/编辑确认后，再开始生成有声书"
        type="info"
        :closable="false"
        class="failed-alert"
      />
      <div class="progress-actions">
        <el-button v-if="bookDetail?.status === 'running'" type="warning" round @click="handlePause">
          暂停
        </el-button>
        <template v-if="bookDetail?.params.useLLM">
          <el-button
            v-if="!hasCharacterVoices"
            type="primary"
            size="large"
            round
            :disabled="bookDetail.status === 'running' || !!bookDetail.planning"
            :loading="planningLoading"
            @click="handlePlanVoices"
          >
            ① 生成角色音色
          </el-button>
          <el-button
            v-else-if="bookDetail.status !== 'completed'"
            type="primary"
            size="large"
            round
            @click="handleResume"
          >
            ② 确认音色，开始生成有声书
          </el-button>
        </template>
        <template v-else>
          <el-button
            v-if="bookDetail && bookDetail.status !== 'running' && bookDetail.status !== 'completed'"
            type="primary"
            round
            @click="handleResume"
          >
            继续生成
          </el-button>
        </template>
        <el-button v-if="failedCount" type="danger" round plain @click="handleRetryFailed">
          重试失败章节
        </el-button>
        <el-button round plain @click="backToUpload">新建有声书</el-button>
      </div>

      <section v-if="bookDetail?.characterVoices?.length" class="character-card">
        <div class="character-head">
          <h3>🎭 角色音色表（全书统一）</h3>
          <el-button
            type="primary"
            size="small"
            :loading="savingVoices"
            :disabled="!voicesDirty"
            @click="handleSaveVoices()"
          >
            保存音色修改
          </el-button>
        </div>
        <el-table :data="editingVoices" size="small" max-height="260" row-key="character">
          <el-table-column prop="character" label="角色" width="120" />
          <el-table-column label="性别" width="70">
            <template #default="{ row }">
              {{ genderText(row.gender) }}
            </template>
          </el-table-column>
          <el-table-column label="性格" min-width="170" show-overflow-tooltip>
            <template #default="{ row }">{{ row.description || '—' }}</template>
          </el-table-column>
          <el-table-column label="音色（可编辑）" min-width="230">
            <template #default="{ row }">
              <el-select
                v-model="row.voice"
                size="small"
                filterable
                :class="{ 'voice-gender-warn': voiceGenderMismatch(row) }"
                @change="voicesDirty = true"
              >
                <el-option
                  v-for="v in voiceOptions"
                  :key="v.Name"
                  :label="v.cnName ? `${v.cnName} (${v.Name})` : v.Name"
                  :value="v.Name"
                />
              </el-select>
              <div v-if="voiceGenderMismatch(row)" class="gender-warn-text">⚠ 与角色性别不符</div>
            </template>
          </el-table-column>
          <el-table-column label="试听" width="90">
            <template #default="{ row }">
              <el-button
                type="primary"
                link
                size="small"
                :disabled="previewLoadingCharacter === row.character"
                @click="previewVoice(row)"
              >
                {{ previewLoadingCharacter === row.character ? '合成中' : '▶ 试听' }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <p class="character-tip">
          试听内容为 AI 生成的角色性格自述；修改音色后请先「保存音色修改」再试听。确认满意后点「开始生成有声书」。
        </p>
      </section>

      <el-table
        :data="bookDetail?.chapters || []"
        class="chapter-table"
        max-height="460"
        :row-class-name="failedRowClass"
      >
        <el-table-column type="expand" width="40">
          <template #default="{ row }">
            <div class="chapter-error-detail">
              <template v-if="row.error">
                <div class="error-line">错误信息：{{ row.error }}</div>
                <div class="error-hint">可在修复问题后点击「重试失败章节」，已完成章节不会重复生成。</div>
              </template>
              <span v-else class="error-hint">该章节暂无错误信息。</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="#" width="70">
          <template #default="{ row }">{{ row.index + 1 }}</template>
        </el-table-column>
        <el-table-column prop="title" label="章节标题" min-width="220" show-overflow-tooltip>
          <template #default="{ row }">
            <div>{{ row.title }}</div>
            <div v-if="row.status === 'processing'" class="chapter-progress-line">
              片段进度 {{ row.progress ?? 0 }}% · 已用时 {{ elapsedText(row.startedAt) }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="字数" width="100">
          <template #default="{ row }">{{ row.charCount }}</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }">
            <el-tag :type="chapterStatusType(row.status)">{{ chapterStatusText(row.status) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="160">
          <template #default="{ row }">
            <template v-if="row.status === 'done'">
              <el-button type="primary" link @click="playChapter(row)">播放</el-button>
              <a :href="chapterAudioUrl(bookId!, row.index)" :download="`${row.title}.mp3`">
                <el-button type="success" link>下载</el-button>
              </a>
              <a :href="chapterSrtUrl(bookId!, row.index)" :download="`${row.title}.srt`">
                <el-button type="info" link>字幕</el-button>
              </a>
            </template>
          </template>
        </el-table-column>
      </el-table>
    </section>

    <el-dialog
      v-model="playerVisible"
      :title="playingTitle"
      width="520px"
      @closed="playingUrl = ''"
    >
      <audio
        v-if="playingUrl"
        :src="playingUrl"
        controls
        autoplay
        style="width: 100%"
      ></audio>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { getVoiceList, type Voice } from '@/api/tts'
import { getLlmSettings, saveLlmSettings, getCloneSettings, saveCloneSettings } from '@/api/settings'
import {
  deleteCustomVoice,
  listCustomVoices,
  uploadCustomVoice,
  type CustomVoice,
} from '@/api/voices'
import { LoaderCircle } from 'lucide-vue-next'
import {
  chapterAudioUrl,
  chapterSrtUrl,
  characterPreviewUrl,
  createBook,
  deleteBook,
  getBook,
  listBooks,
  parseBook,
  pauseBook,
  planVoices,
  resumeBook,
  retryFailedChapters,
  saveCharacterVoices,
  type BookDetail,
  type BookSummary,
  type ChapterStatus,
  type CharacterVoice,
  type ParsedChapter,
} from '@/api/book'
import { mapZHVoiceName } from '@/utils'

const languages = ref([
  { code: 'zh-CN', name: '中文（简体）' },
  { code: 'zh-TW', name: '中文（繁体）' },
  { code: 'zh-HK', name: '中文（香港）' },
  { code: 'en-US', name: '英语（美国）' },
  { code: 'en-GB', name: '英语（英国）' },
])

const books = ref<BookSummary[]>([])
const parsedBook = ref<{ title: string; chapters: ParsedChapter[] } | null>(null)
const bookTitle = ref('')
const parseState = ref<{ parsing: boolean; error: string }>({ parsing: false, error: '' })
const creating = ref(false)

const voiceMode = ref<'preset' | 'llm'>('preset')
const selectedLanguage = ref('zh-CN')
const selectedVoice = ref('')
const voiceList = ref<Voice[]>([])
const rate = ref(0)
const pitch = ref(0)
const volume = ref(0)

const chapterTableRef = ref()
const selectedChapters = ref<ParsedChapter[]>([])
const chapterPage = ref(1)
const chapterPageSize = 50

const bookId = ref<string | null>(null)
const bookDetail = ref<BookDetail | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null
// 秒级时钟：驱动"已用时 / 最近活动"的相对时间展示
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null

const playerVisible = ref(false)
const playingUrl = ref('')
const playingTitle = ref('')

const settingsOpen = ref(false)
const llmForm = ref({ baseUrl: '', model: '', apiKey: '' })
const llmApiKeyConfigured = ref(false)
const savingLlm = ref(false)

// 角色音色规划/编辑/试听
const planningLoading = ref(false)
const editingVoices = ref<CharacterVoice[]>([])
const voicesDirty = ref(false)
const savingVoices = ref(false)
const previewLoadingCharacter = ref('')
let previewAudio: HTMLAudioElement | null = null

// 自定义音色（声音克隆）
const customVoices = ref<CustomVoice[]>([])
const cloneOpen = ref(false)
const cloneForm = ref({ baseUrl: '', language: 'zh', wavUrlPrefix: 'http://127.0.0.1:3000' })
const savingClone = ref(false)
const voiceUploading = ref(false)
const uploadError = ref('')
const newVoiceName = ref('')

const filteredVoices = computed(() => {
  const system = voiceList.value
    .filter((voice) => voice.Name.startsWith(selectedLanguage.value))
    .map((voice) => ({ ...voice, cnName: mapZHVoiceName(voice.Name) ?? voice.Name }))
  // 自定义克隆音色始终可选（不受语言过滤限制）
  const custom = customVoices.value.map((v) => ({
    ...v,
    Name: v.voice,
    cnName: `🎙️ ${v.name}（克隆）`,
    Gender: '',
    ContentCategories: [] as string[],
    VoicePersonalities: [] as string[],
  }))
  return [...custom, ...system]
})
const chapterOffset = computed(() => (chapterPage.value - 1) * chapterPageSize)
const pagedChapters = computed(() =>
  parsedBook.value?.chapters.slice(chapterOffset.value, chapterOffset.value + chapterPageSize) || []
)
const allSelected = computed(
  () => !!parsedBook.value && selectedChapters.value.length === parsedBook.value.chapters.length
)
const doneCount = computed(
  () => bookDetail.value?.chapters.filter((c) => c.status === 'done').length || 0
)
const failedCount = computed(
  () => bookDetail.value?.chapters.filter((c) => c.status === 'failed').length || 0
)
const totalCount = computed(
  () => bookDetail.value?.chapters.filter((c) => c.status !== 'skipped').length || 0
)
const progressPercent = computed(() =>
  totalCount.value ? Number(((doneCount.value / totalCount.value) * 100).toFixed(1)) : 0
)
const currentProcessing = computed(
  () => bookDetail.value?.chapters.find((c) => c.status === 'processing') || null
)
const lastActivityText = computed(() => {
  const updatedAt = bookDetail.value?.updatedAt
  if (!updatedAt) return '-'
  const seconds = Math.max(0, Math.floor((nowTick.value - new Date(updatedAt).getTime()) / 1000))
  return seconds < 5 ? '刚刚' : `${seconds} 秒前`
})

function elapsedText(startedAt?: string) {
  if (!startedAt) return '-'
  const seconds = Math.max(0, Math.floor((nowTick.value - new Date(startedAt).getTime()) / 1000))
  if (seconds < 60) return `${seconds} 秒`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

function formatPercent(value: number) {
  return `${value >= 0 ? '+' : ''}${value}%`
}
function formatHz(value: number) {
  return `${value >= 0 ? '+' : ''}${value}Hz`
}
function bookStatusText(status: BookSummary['status']) {
  return status === 'running' ? '生成中' : status === 'completed' ? '已完成' : '已暂停'
}
function bookStatusType(status: BookSummary['status']) {
  return status === 'running' ? 'warning' : status === 'completed' ? 'success' : 'info'
}
function chapterStatusText(status: ChapterStatus) {
  const map = {
    pending: '等待中',
    processing: '生成中',
    done: '已完成',
    failed: '失败',
    skipped: '已跳过',
  }
  return map[status]
}
function chapterStatusType(status: ChapterStatus) {
  const map = {
    pending: 'info',
    processing: 'warning',
    done: 'success',
    failed: 'danger',
    skipped: 'info',
  }
  return map[status] as 'info' | 'warning' | 'success' | 'danger'
}

function failedRowClass({ row }: { row: { status: ChapterStatus } }) {
  return row.status === 'failed' ? 'chapter-row-failed' : ''
}

const voiceOptions = computed(() => {
  const system = voiceList.value.map((voice) => ({
    ...voice,
    cnName: voice.Name.startsWith('zh') ? (mapZHVoiceName(voice.Name) ?? voice.Name) : voice.Name,
  }))
  const custom = customVoices.value.map((v) => ({
    Name: v.voice,
    cnName: `🎙️ ${v.name}（克隆）`,
    Gender: '',
    ContentCategories: [] as string[],
    VoicePersonalities: [] as string[],
  }))
  return [...custom, ...system]
})
const hasCharacterVoices = computed(() => !!bookDetail.value?.characterVoices?.length)

// AI 三步流程当前所处的步骤（0 规划 / 1 确认 / 2 生成）
const aiStep = computed(() => {
  if (!bookDetail.value) return 0
  if (bookDetail.value.status === 'completed') return 3
  if (!hasCharacterVoices.value) return 0
  return bookDetail.value.status === 'running' ? 2 : 1
})

function savedVoiceOf(character: string): string | undefined {
  return bookDetail.value?.characterVoices?.find((c) => c.character === character)?.voice
}

function voiceGenderMismatch(row: { gender?: string; voice: string }): boolean {
  if (!row.gender) return false
  const voiceGender = voiceList.value.find((v) => v.Name === row.voice)?.Gender
  if (!voiceGender) return false
  const wantFemale = row.gender === 'female'
  return (wantFemale && voiceGender === 'Male') || (!wantFemale && voiceGender === 'Female')
}

function genderText(gender?: string) {
  return gender === 'female' ? '女' : gender === 'male' ? '男' : '—'
}

// 轮询刷新 bookDetail 时，若用户有未保存的音色修改则不覆盖编辑副本
watch(
  () => bookDetail.value?.characterVoices,
  (voices) => {
    if (voices && !voicesDirty.value) {
      editingVoices.value = voices.map((c) => ({ ...c }))
    }
  },
  { immediate: true }
)

async function handlePlanVoices() {
  if (!bookId.value) return
  planningLoading.value = true
  try {
    await planVoices(bookId.value)
    ElMessage.success('已开始规划角色音色，AI 通读全书后给出映射（约 1-3 分钟）')
  } catch (error) {
    ElMessage.error((error as Error).message)
  } finally {
    planningLoading.value = false
  }
}

async function handleSaveVoices(silent = false): Promise<boolean> {
  if (!bookId.value || !editingVoices.value.length) return false
  savingVoices.value = true
  try {
    await saveCharacterVoices(
      bookId.value,
      editingVoices.value.map((v) => ({ character: v.character, voice: v.voice }))
    )
    voicesDirty.value = false
    if (!silent) ElMessage.success('角色音色已更新')
    await refreshDetail()
    return true
  } catch (error) {
    if (!silent) ElMessage.error((error as Error).message)
    return false
  } finally {
    savingVoices.value = false
  }
}

async function previewVoice(row: CharacterVoice) {
  if (!bookId.value) return
  previewLoadingCharacter.value = row.character
  try {
    // 若该行音色有未保存的修改，先静默保存，确保试听的是新音色
    if (row.voice !== savedVoiceOf(row.character)) {
      const ok = await handleSaveVoices(true)
      if (!ok) return
    }
    const res = await fetch(characterPreviewUrl(bookId.value, row.character), {
      signal: AbortSignal.timeout(60_000),
    })
    const contentType = res.headers.get('content-type') || ''
    if (!res.ok || !contentType.includes('audio')) {
      // 后端返回的错误信息（如克隆服务未配置）直接透出
      let message = `试听失败（HTTP ${res.status}）`
      try {
        const err = await res.json()
        if (err?.message) message = err.message
      } catch {
        // 非 JSON 错误体
      }
      throw new Error(message)
    }
    const blob = await res.blob()
    previewAudio?.pause()
    const audio = new Audio(URL.createObjectURL(blob))
    previewAudio = audio
    audio.onended = () => URL.revokeObjectURL(audio.src)
    audio.play().catch(() => ElMessage.error('浏览器无法播放该音频'))
  } catch (error) {
    ElMessage.error((error as Error).message || '试听失败，请稍后重试')
  } finally {
    previewLoadingCharacter.value = ''
  }
}

async function loadVoiceList() {
  try {
    const response = await getVoiceList()
    voiceList.value = response.data || []
    filterVoiceOptions()
  } catch {
    ElMessage.error('获取声音列表失败')
  }
}

function filterVoiceOptions() {
  const system = voiceList.value.filter((v) => v.Name.startsWith(selectedLanguage.value))
  const candidates = [
    ...customVoices.value.map((v) => v.voice),
    ...system.map((v) => v.Name),
  ]
  if (!candidates.includes(selectedVoice.value)) {
    selectedVoice.value = customVoices.value[0]?.voice || system[0]?.Name || ''
  }
}

async function refreshBooks() {
  books.value = await listBooks().catch(() => [])
}

async function handleDeleteBook(id: string, title: string) {
  try {
    await ElMessageBox.confirm(
      `将删除《${title}》及全部本地文件（音频、字幕、正文），删除后不可恢复。确定删除吗？`,
      '删除有声书',
      { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' }
    )
  } catch {
    return
  }
  try {
    await deleteBook(id)
    ElMessage.success('有声书已删除')
    // 删除的是当前打开的书时，退回新建视图
    if (bookId.value === id) backToUpload()
    await refreshBooks()
  } catch (error) {
    ElMessage.error((error as Error).message || '删除失败')
  }
}

async function copyDir(dir: string) {
  try {
    await navigator.clipboard.writeText(dir)
    ElMessage.success('目录已复制')
  } catch {
    ElMessage.error(dir)
  }
}

async function loadCustomVoices() {
  customVoices.value = await listCustomVoices().catch(() => [])
}

async function loadCloneSettings() {
  try {
    cloneForm.value = { ...cloneForm.value, ...(await getCloneSettings()) }
  } catch {
    // 配置加载失败不阻塞页面
  }
}

async function handleSaveCloneSettings() {
  savingClone.value = true
  try {
    await saveCloneSettings({ ...cloneForm.value })
    ElMessage.success('克隆服务配置已保存')
  } catch (error) {
    ElMessage.error((error as Error).message || '保存失败')
  } finally {
    savingClone.value = false
  }
}

async function handleUploadVoice(file: UploadFile) {
  const raw = file.raw
  if (!raw) return
  const name = (raw.name || '').trim()
  const ext = name.slice(name.lastIndexOf('.')) || '.wav'
  if (!/\.(wav|mp3|m4a|flac|ogg)$/i.test(name)) {
    ElMessage.error('仅支持 wav/mp3/m4a/flac/ogg 音频！')
    return
  }
  if (!newVoiceName.value.trim()) {
    ElMessage.error('请先填写音色名称')
    return
  }
  voiceUploading.value = true
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(new Error('文件读取失败'))
      reader.readAsDataURL(raw)
    })
    await uploadCustomVoice(newVoiceName.value.trim(), dataUrl.slice(dataUrl.indexOf(',') + 1), ext)
    ElMessage.success('自定义音色已上传')
    newVoiceName.value = ''
    await loadCustomVoices()
  } catch (error) {
    ElMessage.error((error as Error).message || '上传失败')
  } finally {
    voiceUploading.value = false
  }
}

async function handleDeleteVoice(id: string) {
  try {
    await ElMessageBox.confirm('确定删除该自定义音色吗？', '删除音色', {
      confirmButtonText: '删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }
  try {
    await deleteCustomVoice(id)
    ElMessage.success('已删除')
    await loadCustomVoices()
    filterVoiceOptions()
  } catch (error) {
    ElMessage.error((error as Error).message || '删除失败')
  }
}

function handleFileChange(file: UploadFile) {
  const raw = file.raw
  if (!raw) return
  const name = raw.name || ''
  if (!/\.(epub|txt)$/i.test(name)) {
    ElMessage.error('仅支持 .epub 和 .txt 文件！')
    return
  }
  parseState.value = { parsing: true, error: '' }
  const reader = new FileReader()
  reader.onload = async () => {
    try {
      const dataUrl = String(reader.result || '')
      const contentBase64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
      const result = await parseBook(name, contentBase64)
      parsedBook.value = {
        title: result.title,
        // key 供 el-table 跨页保留勾选（reserve-selection）使用
        chapters: result.chapters.map((c, i) => ({ ...c, key: i })),
      }
      bookTitle.value = result.title
      chapterPage.value = 1
      selectedChapters.value = []
      ElMessage.success(`解析成功：${result.chapters.length} 章`)
    } catch (error) {
      parseState.value.error = (error as Error).message || '解析失败'
      parsedBook.value = null
    } finally {
      parseState.value.parsing = false
    }
  }
  reader.onerror = () => {
    parseState.value.parsing = false
    parseState.value.error = '文件读取失败'
  }
  reader.readAsDataURL(raw)
}

function handleSelectionChange(rows: ParsedChapter[]) {
  selectedChapters.value = rows
}

function toggleAllChapters() {
  const table = chapterTableRef.value
  if (!table) return
  if (allSelected.value) {
    table.clearSelection()
  } else {
    table.toggleAllSelection()
  }
}

async function handleCreate() {
  if (!parsedBook.value || !selectedChapters.value.length) return
  if (!selectedVoice.value) {
    ElMessage.error('请选择声音！')
    return
  }
  creating.value = true
  try {
    const selected = new Set(selectedChapters.value)
    const { bookId: newBookId } = await createBook({
      title: bookTitle.value || '未命名有声书',
      chapters: parsedBook.value.chapters.map((c) => ({
        title: c.title,
        content: c.content,
        include: selected.has(c),
      })),
      params: {
        voice: selectedVoice.value,
        rate: formatPercent(rate.value),
        pitch: formatHz(pitch.value),
        volume: formatPercent(volume.value),
        useLLM: voiceMode.value === 'llm',
      },
      // AI 模式需先规划角色音色并确认，不自动开始生成
      autostart: voiceMode.value === 'preset',
    })
    bookId.value = newBookId
    ElMessage.success('有声书已创建，开始生成！')
    await refreshBooks()
    startPolling()
  } catch (error) {
    ElMessage.error((error as Error).message || '创建失败')
  } finally {
    creating.value = false
  }
}

async function openBook(id: string) {
  try {
    bookDetail.value = await getBook(id)
    bookId.value = id
    startPolling()
  } catch (error) {
    ElMessage.error((error as Error).message || '打开有声书失败')
  }
}

function backToUpload() {
  stopPolling()
  bookId.value = null
  bookDetail.value = null
  refreshBooks()
}

async function handlePause() {
  if (!bookId.value) return
  try {
    await pauseBook(bookId.value)
    ElMessage.success('将在当前章节完成后暂停')
    await refreshDetail()
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function handleResume() {
  if (!bookId.value) return
  try {
    await resumeBook(bookId.value)
    ElMessage.success('已开始续传')
    await refreshDetail()
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function handleRetryFailed() {
  if (!bookId.value) return
  try {
    await retryFailedChapters(bookId.value)
    ElMessage.success('已开始重试失败章节')
    await refreshDetail()
  } catch (error) {
    ElMessage.error((error as Error).message)
  }
}

async function refreshDetail() {
  if (!bookId.value) return
  try {
    bookDetail.value = await getBook(bookId.value)
    // 已完成的书无需继续轮询
    if (bookDetail.value.status === 'completed') stopPolling()
  } catch {
    // 轮询中偶发失败忽略
  }
}

function startPolling() {
  stopPolling()
  refreshDetail()
  pollTimer = setInterval(refreshDetail, 2000)
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer)
    pollTimer = null
  }
}

function playChapter(row: { index: number; title: string }) {
  if (!bookId.value) return
  playingUrl.value = chapterAudioUrl(bookId.value, row.index)
  playingTitle.value = row.title
  playerVisible.value = true
}

async function loadLlmSettings() {
  try {
    const settings = await getLlmSettings()
    llmForm.value.baseUrl = settings.baseUrl
    llmForm.value.model = settings.model
    llmApiKeyConfigured.value = settings.apiKeyConfigured
  } catch {
    // 配置加载失败不阻塞页面
  }
}

async function handleSaveLlmSettings() {
  savingLlm.value = true
  try {
    const settings = await saveLlmSettings({
      baseUrl: llmForm.value.baseUrl.trim(),
      model: llmForm.value.model.trim(),
      apiKey: llmForm.value.apiKey.trim() || undefined,
    })
    llmApiKeyConfigured.value = settings.apiKeyConfigured
    llmForm.value.apiKey = ''
    ElMessage.success('配置已保存并立即生效')
  } catch (error) {
    ElMessage.error((error as Error).message || '保存配置失败')
  } finally {
    savingLlm.value = false
  }
}

onMounted(async () => {
  loadVoiceList()
  refreshBooks()
  loadLlmSettings()
  loadCustomVoices()
  loadCloneSettings()
  tickTimer = setInterval(() => (nowTick.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  stopPolling()
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  previewAudio?.pause()
})
</script>

<style scoped lang="less">
.book-container {
  max-width: 1100px;
  margin: 0 auto;
  padding: 40px 0 60px;
}
.header {
  text-align: center;
  margin-bottom: 30px;
  .title {
    font-size: 40px;
    font-weight: 700;
  }
  .subtitle {
    margin-top: 8px;
    color: #666;
    font-size: 16px;
  }
}
.section {
  background: rgba(255, 255, 255, 0.75);
  border-radius: 16px;
  padding: 24px;
  margin-bottom: 24px;
  .section-title {
    font-size: 20px;
    margin-bottom: 16px;
  }
}
.upload-box {
  width: 100%;
  .upload-inner {
    padding: 24px 0;
    .upload-main {
      font-size: 16px;
      color: #333;
    }
    .upload-sub {
      margin-top: 6px;
      font-size: 13px;
      color: #999;
    }
  }
}
.parse-tip {
  margin-top: 10px;
  color: #999;
}
.settings-head {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
  .section-title {
    margin-bottom: 0;
  }
  .settings-toggle {
    margin-left: auto;
    color: #999;
    font-size: 13px;
  }
}
.settings-tip {
  margin: 12px 0;
  color: #666;
  font-size: 13px;
}
.upload-voice-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}
.upload-voice-row .el-upload {
  margin-left: 0;
}
.settings-actions {
  margin-top: 14px;
}
.config-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 16px;
  margin-top: 20px;
  .config-item {
    label {
      display: block;
      margin-bottom: 6px;
      color: #666;
      font-size: 14px;
    }
    &.sliders {
      grid-column: span 2;
    }
    &.llm-tip {
      grid-column: span 2;
    }
  }
}
.chapter-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 20px 0 10px;
  h3 {
    font-size: 16px;
  }
}
.create-actions {
  margin-top: 20px;
  text-align: center;
}
.progress-head {
  display: flex;
  align-items: center;
  gap: 16px;
  .progress-bar {
    flex: 1;
  }
  .progress-text {
    color: #666;
    white-space: nowrap;
  }
}
.failed-alert {
  margin: 14px 0;
}
.ai-steps {
  margin: 18px 0 6px;
}
.current-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0;
  padding: 10px 14px;
  background: #fdf6ec;
  border-radius: 8px;
  color: #b88230;
  font-size: 14px;
  .spin-icon {
    animation: rotate 1.2s linear infinite;
    flex-shrink: 0;
  }
}
@keyframes rotate {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}
.progress-actions {
  margin: 16px 0;
  display: flex;
  gap: 12px;
}
.chapter-table {
  width: 100%;
}
.dir-text {
  color: #666;
  font-size: 12px;
  user-select: text;
}
.chapter-progress-line {
  margin-top: 2px;
  color: #e6a23c;
  font-size: 12px;
}
.character-card {
  margin-top: 18px;
  padding: 14px;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 10px;
  .character-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    h3 {
      margin: 0;
      font-size: 15px;
    }
  }
  .voice-name {
    color: #999;
    font-size: 12px;
  }
}
.character-tip {
  margin-top: 10px;
  color: #999;
  font-size: 12px;
}
.voice-gender-warn :deep(.el-input__wrapper) {
  box-shadow: 0 0 0 1px #e6a23c inset;
}
.gender-warn-text {
  margin-top: 2px;
  color: #e6a23c;
  font-size: 12px;
}
:deep(.chapter-row-failed) {
  background: #fef0f0;
}
.chapter-error-detail {
  padding: 8px 16px;
  .error-line {
    color: #f56c6c;
    font-size: 13px;
    word-break: break-all;
    line-height: 1.6;
  }
  .error-hint {
    margin-top: 4px;
    color: #999;
    font-size: 12px;
  }
}
@media (max-width: 768px) {
  .config-grid .config-item {
    &.sliders,
    &.llm-tip {
      grid-column: span 1;
    }
  }
}
</style>
