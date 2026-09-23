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
          <el-button :loading="llmTesting" @click="handleTestLlm">测试连接</el-button>
        </div>
        <el-alert
          v-if="llmTestResult"
          :type="llmTestResult.ok ? 'success' : 'error'"
          :title="llmTestResult.message"
          :description="
            llmTestResult.latencyMs ? `耗时 ${Math.round(llmTestResult.latencyMs / 100) / 10} 秒` : ''
          "
          :closable="false"
          class="failed-alert"
          show-icon
        />
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
          xtts-api-server），并在下方配置服务地址；参考音频通过目录挂载供克隆服务读取。
          克隆音色合成速度取决于硬件，无 GPU 时较慢（每句约 10~40 秒），长篇有声书建议优先使用
          Edge 音色或 Edge 预设。
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
        </div>
        <div class="settings-actions">
          <el-button type="primary" :loading="savingClone" @click="handleSaveCloneSettings">
            保存克隆服务配置
          </el-button>
          <el-button :loading="testingClone" @click="handleTestClone">测试连接</el-button>
        </div>
        <el-alert
          v-if="cloneTestResult"
          :type="cloneTestResult.ok ? 'success' : 'error'"
          :title="cloneTestResult.message"
          :description="
            cloneTestResult.latencyMs
              ? `耗时 ${Math.round(cloneTestResult.latencyMs / 100) / 10} 秒`
              : ''
          "
          :closable="false"
          class="failed-alert"
          show-icon
        />

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
          <el-table-column prop="name" label="名称" width="150" />
          <el-table-column prop="voice" label="音色 ID" min-width="190" show-overflow-tooltip />
          <el-table-column label="操作" width="130">
            <template #default="{ row }">
              <el-button
                link
                type="primary"
                :disabled="clonePreviewingId === row.id"
                @click="handlePreviewCloneVoice(row)"
              >
                {{ clonePreviewingId === row.id ? '合成中' : '试听' }}
              </el-button>
              <el-button type="danger" link @click="handleDeleteVoice(row.id)">删除</el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
    </section>

    <!-- 自定义 Edge 音色（快速预设） -->
    <section class="section">
      <div class="settings-head" @click="presetOpen = !presetOpen">
        <h2 class="section-title">🎛️ 自定义音色（Edge 预设）</h2>
        <el-tag :type="voicePresets.length ? 'success' : 'info'" size="small">
          {{ voicePresets.length ? `已有 ${voicePresets.length} 个` : '未创建' }}
        </el-tag>
        <span class="settings-toggle">{{ presetOpen ? '收起 ▲' : '展开 ▼' }}</span>
      </div>
      <template v-if="presetOpen">
        <p class="settings-tip">
          基于任意 Edge 内置音色自定义语速 / 音调 / 情感风格，保存为可直接选用的音色。生成速度与普通
          Edge 音色完全一致（无需克隆推理），适合长篇有声书；克隆音色较慢，建议只给少数重点角色使用。
          保存后可在下方音色选择和 AI 智能配音中使用。
        </p>
        <div class="config-grid">
          <div class="config-item">
            <label>音色名称</label>
            <el-input v-model="presetForm.name" placeholder="如：低沉说书人" maxlength="30" />
          </div>
          <div class="config-item">
            <label>基础音色</label>
            <el-select
              v-model="presetForm.voice"
              filterable
              placeholder="选择 Edge 内置音色"
              style="width: 100%"
            >
              <el-option
                v-for="v in presetBaseVoices"
                :key="v.Name"
                :value="v.Name"
                :label="v.cnName || v.Name"
              />
            </el-select>
          </div>
          <div class="config-item">
            <label>情感风格（仅晓伊/云希等部分音色支持）</label>
            <el-select v-model="presetForm.style" clearable placeholder="默认（不加风格）">
              <el-option v-for="s in presetStyles" :key="s" :value="s" :label="presetStyleLabel(s)" />
            </el-select>
          </div>
          <div class="config-item sliders">
            <label>语速 {{ presetForm.rate > 0 ? '+' : '' }}{{ presetForm.rate }}%</label>
            <el-slider v-model="presetForm.rate" :min="-50" :max="100" :step="5" />
          </div>
          <div class="config-item sliders">
            <label>音调 {{ presetForm.pitch > 0 ? '+' : '' }}{{ presetForm.pitch }}Hz</label>
            <el-slider v-model="presetForm.pitch" :min="-50" :max="50" :step="5" />
          </div>
        </div>
        <div class="settings-actions">
          <el-button :loading="presetPreviewing" @click="handlePreviewPreset">试听效果</el-button>
          <el-button type="primary" :loading="presetSaving" @click="handleSavePreset">
            保存音色
          </el-button>
        </div>

        <el-table
          v-if="voicePresets.length"
          :data="voicePresets"
          size="small"
          max-height="220"
          style="margin-top: 12px"
        >
          <el-table-column prop="name" label="名称" width="150" />
          <el-table-column prop="voice" label="基础音色" min-width="180" show-overflow-tooltip />
          <el-table-column label="参数" min-width="180">
            <template #default="{ row }">{{ presetParamsText(row) }}</template>
          </el-table-column>
          <el-table-column label="操作" width="130">
            <template #default="{ row }">
              <el-button
                link
                type="primary"
                :disabled="presetPreviewingId === row.id"
                @click="handlePreviewSavedPreset(row)"
              >
                {{ presetPreviewingId === row.id ? '合成中' : '试听' }}
              </el-button>
              <el-button link type="danger" @click="handleDeletePreset(row.id)">删除</el-button>
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
            <el-tag :type="row.planning ? 'warning' : bookStatusType(row.status)">
              {{ row.planning ? '规划中' : bookStatusText(row.status) }}
            </el-tag>
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
          <div v-if="voiceMode === 'llm'" class="config-item">
            <label>配音引擎</label>
            <el-select v-model="voiceEngine" @change="ensureVcInfo">
              <el-option label="Edge 预设（免费，推荐）" value="edge" />
              <el-option label="OpenVoice 换声（参考音色，需 vc 服务）" value="openvoice" />
              <el-option label="RVC 换声（需已训练模型，相似度最高）" value="rvc" />
              <el-option label="OmniVoice 克隆（新一代零样本，需 omnivoice 服务，CPU 较慢）" value="omnivoice" />
              <el-option label="XTTS 声音克隆（直接用参考声音，较慢）" value="clone" />
            </el-select>
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
        <el-tag v-if="bookDetail.params.useLLM" type="info" effect="plain">
          {{ engineLabel }}
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
        <span>
          {{ bookDetail.planningDetail || 'AI 正在通读全书，按角色性格规划音色…' }}
          {{ planningElapsedText }}
        </span>
        <el-button size="small" :loading="stoppingPlan" @click="handleStopPlan">
          停止规划
        </el-button>
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
        <el-button
          v-if="bookDetail && bookDetail.status !== 'running'"
          round
          @click="openSelectionDialog"
        >
          选择章节
        </el-button>
        <template v-if="bookDetail?.params.useLLM">
          <el-radio-group
            v-if="!hasCharacterVoices"
            v-model="voiceAssignMode"
            :disabled="!!bookDetail.planning"
            style="margin-right: 16px"
          >
            <el-radio value="match">按性格匹配已配置音色</el-radio>
            <el-radio value="generate">AI 生成专属音色（每角色独立）</el-radio>
          </el-radio-group>
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
        <el-dropdown
          v-if="bookDetail && bookDetail.status !== 'running' && !bookDetail?.planning && doneCount + failedCount > 0"
          @command="handleRegenerateAll"
        >
          <el-button round plain type="warning" :loading="regenerateAllLoading">
            重新生成全书<el-icon class="el-icon--right"><arrow-down /></el-icon>
          </el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="cached">
                常规模式：复用未变化的片段（快，推荐改音色/换声源后使用）
              </el-dropdown-item>
              <el-dropdown-item command="fresh">
                强制全新合成：忽略缓存全部重做（慢，彻底重修音质问题）
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button round plain @click="backToUpload">新建有声书</el-button>
      </div>

      <el-dialog v-model="selectionDialogVisible" title="选择章节" width="640px">
        <p class="selection-tip">
          勾选的章节会（重新）纳入生成队列，取消勾选的未开始章节将跳过；已完成章节不受影响。保存后回到本页继续操作。
        </p>
        <el-table
          ref="selectionTableRef"
          :data="bookDetail?.chapters || []"
          max-height="420"
          row-key="index"
          @selection-change="handleProgressSelectionChange"
        >
          <el-table-column type="selection" width="46" :selectable="selectionSelectable" reserve-selection />
          <el-table-column label="#" width="70">
            <template #default="{ row }">{{ row.index + 1 }}</template>
          </el-table-column>
          <el-table-column prop="title" label="章节标题" min-width="200" show-overflow-tooltip />
          <el-table-column label="状态" width="110">
            <template #default="{ row }">
              <el-tag :type="chapterStatusType(row.status)" size="small">
                {{ chapterStatusText(row.status) }}
              </el-tag>
            </template>
          </el-table-column>
        </el-table>
        <template #footer>
          <span v-if="selectionSaving" class="selection-tip">保存中…</span>
          <el-button @click="selectionDialogVisible = false">取消</el-button>
          <el-button type="primary" :loading="selectionSaving" @click="confirmSelection">
            保存选择
          </el-button>
        </template>
      </el-dialog>

      <section v-if="bookDetail?.characterVoices?.length" class="character-card">
        <div class="character-head">
          <h3>
            🎭 角色音色表（全书统一
            <template v-if="characterSearch.trim()">
              匹配 {{ filteredEditingVoices.length }}/{{ speakingRows.length }} 人）
            </template>
            <template v-else>共 {{ speakingRows.length }} 个有对白的角色）</template>
          </h3>
          <el-input
            v-model="characterSearch"
            class="character-search"
            size="small"
            clearable
            placeholder="搜索角色 / 称呼 / 性格"
            :prefix-icon="Search"
          />
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
        <!-- 内嵌播放器：试听（角色音色试听，支持上一曲/下一曲） -->
        <div class="inline-player">
          <div class="player-row">
            <span class="player-tag player-tag-preview">🎧 试听</span>
            <el-button-group>
              <el-button size="small" :icon="SkipBack" :disabled="!previewPlayerIndex" @click="previewPlayerPrev" />
              <el-button
                size="small"
                type="primary"
                :loading="previewLoadingCharacter !== ''"
                :disabled="!filteredEditingVoices.length && previewPlayerIndex < 0"
                @click="previewPlayerToggle"
              >
                <el-icon :size="14"><component :is="previewPlaying ? Pause : Play" /></el-icon>
              </el-button>
              <el-button size="small" :icon="SkipForward" :disabled="!filteredEditingVoices.length" @click="previewPlayerNext" />
            </el-button-group>
            <span class="player-title" :title="previewPlayerTitle">
              {{ previewPlayerTitle || '点击角色表的 ▶ 试听，或按下一曲逐个试听' }}
            </span>
            <span class="player-time">{{ fmtTime(previewCurrentTime) }} / {{ fmtTime(previewDuration) }}</span>
          </div>
          <el-slider
            class="player-slider"
            :max="previewDuration || 1"
            :step="0.1"
            :model-value="previewCurrentTime"
            size="small"
            @input="previewSeek"
          />
          <div class="player-subtitle" v-if="previewSubtitle">{{ previewSubtitle }}</div>
        </div>
        <!-- 批量设置：勾选角色后统一应用音色/换声源 -->
        <div v-if="selectedVoiceRows.length" class="batch-bar">
          <span class="batch-count">已选 {{ selectedVoiceRows.length }} 个角色</span>
          <el-select
            v-model="batchVoice"
            size="small"
            clearable
            filterable
            placeholder="不修改音色"
            class="batch-select"
          >
            <el-option
              v-for="v in voiceOptions"
              :key="v.Name"
              :label="v.cnName ? `${v.cnName} (${v.Name})` : v.Name"
              :value="v.Name"
            />
          </el-select>
          <el-select
            v-if="isVcEngineBook"
            v-model="batchVcRef"
            size="small"
            filterable
            placeholder="不修改换声源"
            class="batch-select"
          >
            <el-option label="— 解绑换声源（用基础音色）—" value="__unbind__" />
            <el-option v-for="name in vcRefOptions" :key="name" :label="name" :value="name" />
          </el-select>
          <el-button
            type="primary"
            size="small"
            :loading="batchApplying"
            :disabled="!batchVoice && !batchVcRef"
            @click="applyBatchVoices"
          >
            应用到选中角色
          </el-button>
          <el-button size="small" @click="clearVoiceSelection">取消选择</el-button>
        </div>
        <el-table
          ref="voiceTableRef"
          :data="filteredEditingVoices"
          size="small"
          max-height="260"
          row-key="character"
          @selection-change="handleVoiceSelectionChange"
        >
          <el-table-column type="selection" width="38" reserve-selection />
          <el-table-column prop="character" label="角色" width="120" />
          <el-table-column label="对白" width="70">
            <template #default="{ row }">
              {{ row.character === '旁白' ? '—' : `${row.dialog ?? 0} 句` }}
            </template>
          </el-table-column>
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
          <el-table-column v-if="isVcEngineBook" label="换声源" min-width="150">
            <template #default="{ row }">
              <el-select
                v-model="row.vcRef"
                size="small"
                clearable
                filterable
                :placeholder="vcRefOptions.length ? '选择换声源' : '无可换声源'"
                @focus="ensureVcInfo"
                @change="voicesDirty = true"
              >
                <el-option v-for="name in vcRefOptions" :key="name" :label="name" :value="name" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="试听" width="130">
            <template #default="{ row }">
              <el-button
                type="primary"
                link
                size="small"
                :disabled="previewLoadingCharacter === row.character || downloadingCharacter === row.character"
                @click="previewVoice(row)"
              >
                {{ previewLoadingCharacter === row.character ? '合成中' : '▶ 试听' }}
              </el-button>
              <el-button
                type="success"
                link
                size="small"
                :disabled="previewLoadingCharacter === row.character || downloadingCharacter === row.character"
                @click="downloadPreview(row)"
              >
                {{ downloadingCharacter === row.character ? '合成中' : '下载' }}
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <p class="character-tip">
          试听内容为 AI 生成的角色性格自述；修改音色后请先「保存音色修改」再试听。确认满意后点「开始生成有声书」。
        </p>
      </section>

      <!-- 内嵌播放器：章节阅读（支持上一章/下一章、同步字幕） -->
      <div class="inline-player">
        <div class="player-row">
          <span class="player-tag">📖 章节</span>
          <el-button-group>
            <el-button size="small" :icon="SkipBack" :disabled="!playableChapters.length" @click="chapterPlayerPrev" />
            <el-button
              size="small"
              type="primary"
              :disabled="!playableChapters.length"
              @click="chapterPlayerToggle"
            >
              <el-icon :size="14"><component :is="chapterPlaying ? Pause : Play" /></el-icon>
            </el-button>
            <el-button size="small" :icon="SkipForward" :disabled="!playableChapters.length" @click="chapterPlayerNext" />
          </el-button-group>
          <span class="player-title" :title="chapterPlayerTitle">
            {{ chapterPlayerTitle || '点击章节列表的「播放」，或按下一曲连续听书' }}
          </span>
          <span class="player-time">{{ fmtTime(chapterCurrentTime) }} / {{ fmtTime(chapterDuration) }}</span>
        </div>
        <el-slider
          class="player-slider"
          :max="chapterDuration || 1"
          :step="0.1"
          :model-value="chapterCurrentTime"
          size="small"
          @input="chapterSeek"
        />
        <div class="player-subtitle" v-if="chapterSubtitle">{{ chapterSubtitle }}</div>
      </div>

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
                <div class="error-actions">
                  <el-button size="small" type="primary" link @click="copyChapterError(row)">
                    复制错误信息
                  </el-button>
                </div>
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
        <el-table-column label="操作" width="200">
          <template #default="{ row }">
            <template v-if="row.status === 'done'">
              <el-button type="primary" link @click="playChapter(row)">播放</el-button>
              <a :href="chapterAudioUrl(bookId!, row.index)" :download="`${row.title}.mp3`">
                <el-button type="success" link>下载</el-button>
              </a>
              <a :href="chapterSrtUrl(bookId!, row.index)" :download="`${row.title}.srt`">
                <el-button type="info" link>字幕</el-button>
              </a>
              <el-button
                type="warning"
                link
                :disabled="regeneratingIndex !== null"
                @click="handleRegenerateChapter(row)"
              >
                {{ regeneratingIndex === row.index ? '生成中' : '重新生成' }}
              </el-button>
            </template>
            <el-button
              v-else-if="row.status === 'failed'"
              type="warning"
              link
              :disabled="regeneratingIndex !== null"
              @click="handleRegenerateChapter(row)"
            >
              {{ regeneratingIndex === row.index ? '生成中' : '重新生成' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { UploadFile } from 'element-plus'
import { getVoiceList, type Voice } from '@/api/tts'
import {
  getLlmSettings,
  saveLlmSettings,
  testLlmSettings,
  getCloneSettings,
  saveCloneSettings,
  testCloneSettings,
  type LlmTestResult,
} from '@/api/settings'
import {
  deleteCustomVoice,
  listCustomVoices,
  uploadCustomVoice,
  previewCustomVoice,
  deleteVoicePreset,
  listVoicePresets,
  previewPresetVoice,
  saveVoicePreset,
  getVcInfo,
  type CustomVoice,
  type VoicePreset,
  type VcInfo,
} from '@/api/voices'
import { LoaderCircle, Search, Play, Pause, SkipBack, SkipForward, ArrowDown } from 'lucide-vue-next'
import {
  chapterAudioUrl,
  chapterSrtUrl,
  characterPreviewUrl,
  createBook,
  deleteBook,
  updateChapterSelection,
  getBook,
  listBooks,
  parseBook,
  pauseBook,
  planVoices,
  stopPlanVoices,
  resumeBook,
  retryFailedChapters,
  regenerateChapter,
  regenerateAll,
  saveCharacterVoices,
  type BookDetail,
  type BookSummary,
  type BookChapter,
  type ChapterStatus,
  type CharacterVoice,
  type ParsedChapter,
  type VoiceEngine,
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
const chapterPageSize = 100

const bookId = ref<string | null>(null)
const bookDetail = ref<BookDetail | null>(null)
let pollTimer: ReturnType<typeof setInterval> | null = null
// 记住最后打开的书：刷新页面后自动恢复详情视图，规划/生成进度不丢
const LAST_BOOK_KEY = 'easyvoice:lastBookId'
// 秒级时钟：驱动"已用时 / 最近活动"的相对时间展示
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null

// ===== 内嵌播放器状态（试听 / 章节阅读，替代旧的弹窗播放器）=====
let previewAudioEl: HTMLAudioElement | null = null
let previewObjectUrl = ''
const previewPlayerIndex = ref(-1)
const previewPlaying = ref(false)
const previewCurrentTime = ref(0)
const previewDuration = ref(0)
let chapterAudioEl: HTMLAudioElement | null = null
const chapterPlayerIndex = ref(-1)
const chapterPlaying = ref(false)
const chapterCurrentTime = ref(0)
const chapterDuration = ref(0)
const chapterSubtitle = ref('')
let chapterCues: { start: number; end: number; text: string }[] = []

const settingsOpen = ref(false)
const llmForm = ref({ baseUrl: '', model: '', apiKey: '' })
const llmApiKeyConfigured = ref(false)
const savingLlm = ref(false)

// 角色音色规划/编辑/试听
const planningLoading = ref(false)
// 音色分配方式：match=按性格匹配已配置预设；generate=AI 为每个角色生成专属预设
const voiceAssignMode = ref<'match' | 'generate'>('generate')
// 配音引擎：edge=纯 Edge 预设 / clone=XTTS 克隆 / openvoice / rvc / omnivoice（创建时选定）
const voiceEngine = ref<VoiceEngine>('edge')
const vcInfo = ref<VcInfo | null>(null)
/** 换声引擎（openvoice/rvc/omnivoice）下角色表的「换声源」下拉选项 */
const vcRefOptions = computed(() => {
  if (!vcInfo.value) return []
  return voiceEngine.value === 'rvc'
    ? vcInfo.value.models.map((m) => m.name)
    : vcInfo.value.references
})
async function ensureVcInfo() {
  if (vcInfo.value) return
  try {
    vcInfo.value = await getVcInfo()
  } catch {
    vcInfo.value = { references: [], models: [] }
  }
}
/** 当前书是否使用换声引擎（角色表显示「换声源」列；omnivoice 的换声源即参考音频） */
const isVcEngineBook = computed(
  () => voiceEngine.value === 'openvoice' || voiceEngine.value === 'rvc' || voiceEngine.value === 'omnivoice'
)
const engineLabels: Record<VoiceEngine, string> = {
  edge: 'Edge 预设',
  clone: 'XTTS 克隆',
  openvoice: 'OpenVoice 换声',
  rvc: 'RVC 换声',
  omnivoice: 'OmniVoice 克隆',
}
const engineLabel = computed(() => engineLabels[voiceEngine.value] || 'Edge 预设')
const stoppingPlan = ref(false)
async function handleStopPlan() {
  if (!bookId.value) return
  stoppingPlan.value = true
  try {
    await stopPlanVoices(bookId.value)
    ElMessage.success('正在停止规划，当前章节读完即生效')
  } catch (error) {
    ElMessage.error((error as Error).message || '停止失败')
  } finally {
    stoppingPlan.value = false
  }
}
const editingVoices = ref<CharacterVoice[]>([])
// 角色较多（30+），支持按角色名/称呼/性格描述过滤
const characterSearch = ref('')
// 无对白的角色不参与配音配置，默认不显示（旁白除外）；
// 旧版规划数据没有对白统计（全为 0），此时保留全部避免整表清空
const hasDialogData = computed(() =>
  editingVoices.value.some((c) => c.character !== '旁白' && (c.dialog || 0) > 0)
)
const speakingRows = computed(() => {
  const narrators = editingVoices.value.filter((c) => c.character === '旁白')
  // 其余按对白数降序：戏份多的角色排前面（稳定排序，同数保持原顺序）
  const others = editingVoices.value
    .filter((c) => c.character !== '旁白' && (!hasDialogData.value || (c.dialog || 0) > 0))
    .sort((a, b) => (b.dialog || 0) - (a.dialog || 0))
  return [...narrators, ...others]
})
const filteredEditingVoices = computed(() => {
  // 旁白置顶：叙述占全书大部分篇幅，固定第一行便于确认基准音色
  const rows = speakingRows.value
  const kw = characterSearch.value.trim().toLowerCase()
  if (!kw) return rows
  return rows.filter((c) =>
    [c.character, ...(c.aliases || []), c.description || ''].join(' ').toLowerCase().includes(kw)
  )
})
const voicesDirty = ref(false)
// ===== 批量设置音色/换声源：勾选多个角色后统一应用 =====
const voiceTableRef = ref()
const selectedVoiceRows = ref<CharacterVoice[]>([])
const batchVoice = ref('')
const batchVcRef = ref('')
const batchApplying = ref(false)

function handleVoiceSelectionChange(rows: CharacterVoice[]) {
  selectedVoiceRows.value = rows
}

function clearVoiceSelection() {
  voiceTableRef.value?.clearSelection()
  selectedVoiceRows.value = []
}

async function applyBatchVoices() {
  const rows = selectedVoiceRows.value
  if (!rows.length) return
  if (!batchVoice.value && !batchVcRef.value) {
    ElMessage.warning('请先选择要批量应用的音色或换声源')
    return
  }
  batchApplying.value = true
  try {
    const unbindVc = batchVcRef.value === '__unbind__'
    // 按角色名在"最新"的 editingVoices 上应用修改：勾选行的对象引用可能已被
    // 轮询刷新整体替换，直接改勾选行的引用会改到失效副本上导致保存不生效
    const selectedNames = new Set(rows.map((r) => r.character))
    let changed = 0
    for (const row of editingVoices.value) {
      if (!selectedNames.has(row.character)) continue
      if (batchVoice.value) row.voice = batchVoice.value
      if (isVcEngineBook.value && batchVcRef.value) {
        row.vcRef = unbindVc ? '' : batchVcRef.value
      }
      changed++
    }
    if (!changed) {
      ElMessage.warning('选中的角色已不在列表中，请重新勾选后再应用')
      return
    }
    voicesDirty.value = true
    const ok = await handleSaveVoices(true)
    if (ok) {
      ElMessage.success(`已批量更新 ${rows.length} 个角色并保存`)
      clearVoiceSelection()
      batchVoice.value = ''
      batchVcRef.value = ''
    } else {
      ElMessage.warning('应用成功但保存失败，请检查后手动点击「保存音色修改」')
    }
  } finally {
    batchApplying.value = false
  }
}
const savingVoices = ref(false)
const previewLoadingCharacter = ref('')
/** 试听下载：与试听同链路合成/换声，由浏览器保存为文件（服务端不落盘） */
const downloadingCharacter = ref('')
async function downloadPreview(row: CharacterVoice) {
  if (!bookId.value) return
  downloadingCharacter.value = row.character
  try {
    if (row.voice !== savedVoiceOf(row.character) || (row.vcRef || '') !== savedVcRefOf(row.character)) {
      const ok = await handleSaveVoices(true)
      if (!ok) return
    }
    const res = await fetch(characterPreviewUrl(bookId.value, row.character, true), {
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) {
      let message = `下载失败（HTTP ${res.status}）`
      try {
        const err = await res.json()
        if (err?.message) message = err.message
      } catch {
        // 非 JSON 错误体
      }
      throw new Error(message)
    }
    const blob = await res.blob()
    const isWav = blob.type.includes('wav')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `试听-${row.character}.${isWav ? 'wav' : 'mp3'}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  } catch (error) {
    ElMessage.error((error as Error).message || '下载失败，请稍后重试')
  } finally {
    downloadingCharacter.value = ''
  }
}
// ===== 试听/章节内嵌播放器 =====
const playableChapters = computed(
  () => bookDetail.value?.chapters.filter((c) => c.status === 'done') || []
)

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00'
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function parseSrt(text: string): { start: number; end: number; text: string }[] {
  const toSeconds = (x: string): number => {
    const [h, m, rest] = x.split(':')
    const [sec, ms] = rest.split(',')
    return Number(h) * 3600 + Number(m) * 60 + Number(sec) + Number(ms || 0) / 1000
  }
  const cues: { start: number; end: number; text: string }[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/).filter((l) => l.trim())
    const timeLine = lines.find((l) => l.includes('-->'))
    if (!timeLine) continue
    const [s, e] = timeLine.split('-->').map((x) => x.trim())
    const body = lines.filter((l) => !l.includes('-->') && !/^\d+$/.test(l.trim())).join(' ')
    if (!body) continue
    cues.push({ start: toSeconds(s), end: toSeconds(e), text: body })
  }
  return cues.sort((a, b) => a.start - b.start)
}

// --- 试听播放器 ---

const previewPlayerTitle = computed(() => {
  const row = filteredEditingVoices.value[previewPlayerIndex.value]
  if (!row) return ''
  const preset = voicePresets.value.find((p) => p.id === row.voice)
  const source = isVcEngineBook.value && row.vcRef ? ` · ${row.vcRef}` : ''
  return `${row.character} · ${preset ? preset.name : row.voice}${source}`
})
const previewSubtitle = computed(() => {
  const row = filteredEditingVoices.value[previewPlayerIndex.value]
  if (!row) return ''
  return `我是${row.character}。${row.description || ''}`
})

function previewPlayerToggle() {
  if (previewPlayerIndex.value < 0) {
    if (filteredEditingVoices.value.length) void previewPlayerLoad(0)
    return
  }
  const el = getPreviewAudio()
  if (el.paused) void el.play().catch(() => ElMessage.error('浏览器无法播放该音频'))
  else el.pause()
}
function previewPlayerNext() {
  const total = filteredEditingVoices.value.length
  if (!total) return
  void previewPlayerLoad((previewPlayerIndex.value + 1) % total)
}
function previewPlayerPrev() {
  const total = filteredEditingVoices.value.length
  if (!total) return
  void previewPlayerLoad((previewPlayerIndex.value - 1 + total) % total)
}
function previewSeek(value: number) {
  const el = getPreviewAudio()
  el.currentTime = value
  previewCurrentTime.value = value
}

async function previewPlayerLoad(index: number) {
  const row = filteredEditingVoices.value[index]
  if (!row || !bookId.value) return
  previewPlayerIndex.value = index
  previewLoadingCharacter.value = row.character
  const el = getPreviewAudio()
  try {
    // 若该行音色/换声源有未保存的修改，先静默保存，确保试听的就是最终效果
    if (row.voice !== savedVoiceOf(row.character) || (row.vcRef || '') !== savedVcRefOf(row.character)) {
      const ok = await handleSaveVoices(true)
      if (!ok) return
    }
    const res = await fetch(characterPreviewUrl(bookId.value, row.character), {
      signal: AbortSignal.timeout(120_000),
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
    if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl)
    previewObjectUrl = URL.createObjectURL(blob)
    el.src = previewObjectUrl
    chapterAudioEl?.pause()
    await el.play().catch(() => ElMessage.error('浏览器无法播放该音频'))
  } catch (error) {
    ElMessage.error((error as Error).message || '试听失败，请稍后重试')
  } finally {
    previewLoadingCharacter.value = ''
  }
}

// --- 章节播放器 ---
const chapterPlayerTitle = computed(() => {
  const ch = playableChapters.value[chapterPlayerIndex.value]
  if (!ch) return ''
  return `${ch.index + 1}. ${ch.title}`
})

async function loadChapterSubtitle(chapterIndex: number) {
  chapterCues = []
  chapterSubtitle.value = ''
  if (!bookId.value) return
  try {
    const res = await fetch(chapterSrtUrl(bookId.value, chapterIndex))
    chapterCues = parseSrt(await res.text())
  } catch {
    // 字幕缺失不阻塞播放
  }
}

function chapterPlayerToggle() {
  if (chapterPlayerIndex.value < 0) {
    if (playableChapters.value.length) void chapterPlayerLoad(0)
    return
  }
  const el = getChapterAudio()
  if (el.paused) void el.play().catch(() => ElMessage.error('浏览器无法播放该音频'))
  else el.pause()
}
function chapterPlayerNext() {
  const total = playableChapters.value.length
  if (!total) return
  void chapterPlayerLoad((chapterPlayerIndex.value + 1) % total)
}
function chapterPlayerPrev() {
  const total = playableChapters.value.length
  if (!total) return
  void chapterPlayerLoad((chapterPlayerIndex.value - 1 + total) % total)
}
function chapterSeek(value: number) {
  const el = getChapterAudio()
  el.currentTime = value
  chapterCurrentTime.value = value
}

async function chapterPlayerLoad(index: number) {
  const ch = playableChapters.value[index]
  if (!ch || !bookId.value) return
  chapterPlayerIndex.value = index
  const el = getChapterAudio()
  el.src = chapterAudioUrl(bookId.value, ch.index)
  void loadChapterSubtitle(ch.index)
  previewAudioEl?.pause()
  await el.play().catch(() => ElMessage.error('浏览器无法播放该音频'))
}

function getPreviewAudio(): HTMLAudioElement {
  if (!previewAudioEl) {
    previewAudioEl = new Audio()
    previewAudioEl.preload = 'auto'
    previewAudioEl.addEventListener('timeupdate', () => {
      previewCurrentTime.value = previewAudioEl?.currentTime ?? 0
    })
    previewAudioEl.addEventListener('loadedmetadata', () => {
      previewDuration.value = previewAudioEl?.duration || 0
    })
    previewAudioEl.addEventListener('play', () => {
      previewPlaying.value = true
      chapterAudioEl?.pause()
    })
    previewAudioEl.addEventListener('pause', () => {
      previewPlaying.value = false
    })
    previewAudioEl.addEventListener('ended', () => {
      previewPlaying.value = false
      previewPlayerNext() // 自动播放下一曲，循环试听整个角色列表
    })
  }
  return previewAudioEl
}

function getChapterAudio(): HTMLAudioElement {
  if (!chapterAudioEl) {
    chapterAudioEl = new Audio()
    chapterAudioEl.preload = 'auto'
    chapterAudioEl.addEventListener('timeupdate', () => {
      chapterCurrentTime.value = chapterAudioEl?.currentTime ?? 0
      // 按播放进度同步字幕：命中区间则刷新，未命中保留上一句直到进入下一句
      const t = chapterCurrentTime.value
      const cue = chapterCues.find((c) => t >= c.start && t <= c.end)
      if (cue) chapterSubtitle.value = cue.text
    })
    chapterAudioEl.addEventListener('loadedmetadata', () => {
      chapterDuration.value = chapterAudioEl?.duration || 0
    })
    chapterAudioEl.addEventListener('play', () => {
      chapterPlaying.value = true
      previewAudioEl?.pause()
    })
    chapterAudioEl.addEventListener('pause', () => {
      chapterPlaying.value = false
    })
    chapterAudioEl.addEventListener('ended', () => {
      chapterPlaying.value = false
      chapterPlayerNext() // 自动连播下一章
    })
  }
  return chapterAudioEl
}

// 自定义音色（声音克隆）
const customVoices = ref<CustomVoice[]>([])
const cloneOpen = ref(false)

// 自定义 Edge 音色预设
const presetOpen = ref(false)
const voicePresets = ref<VoicePreset[]>([])
const presetForm = ref({ name: '', voice: '', rate: 0, pitch: 0, style: '' })
const presetSaving = ref(false)
const presetPreviewing = ref(false)
const presetPreviewingId = ref('')
let presetAudio: HTMLAudioElement | null = null
const presetStyles = [
  'cheerful',
  'sad',
  'angry',
  'fearful',
  'disgruntled',
  'serious',
  'affectionate',
  'gentle',
  'calm',
  'lyrical',
  'narration-professional',
  'narration-relaxed',
  'documentary-narration',
]
const presetStyleLabels: Record<string, string> = {
  cheerful: '欢快',
  sad: '悲伤',
  angry: '愤怒',
  fearful: '恐惧',
  disgruntled: '不满',
  serious: '严肃',
  affectionate: '深情',
  gentle: '温柔',
  calm: '平静',
  lyrical: '抒情',
  'narration-professional': '专业旁白',
  'narration-relaxed': '轻松旁白',
  'documentary-narration': '纪录片旁白',
}
function presetStyleLabel(style: string) {
  return presetStyleLabels[style] || style
}
// 预设基础音色候选：纯系统音色（从后端 voiceList 中排除预设与克隆项）
const presetBaseVoices = computed(() =>
  voiceList.value.filter((v) => !v.Name.startsWith('custom-') && !v.Name.startsWith('edge-'))
)
function presetParamsText(row: VoicePreset) {
  const parts: string[] = []
  if (row.rate && row.rate !== '+0%') parts.push(`语速 ${row.rate}`)
  if (row.pitch && row.pitch !== '+0Hz') parts.push(`音调 ${row.pitch}`)
  if (row.volume && row.volume !== '+0%') parts.push(`音量 ${row.volume}`)
  if (row.style) parts.push(`风格 ${presetStyleLabel(row.style)}`)
  return parts.length ? parts.join('，') : '默认'
}
const rateStr = (n: number) => (n > 0 ? `+${n}%` : `${n}%`)
const pitchStr = (n: number) => (n > 0 ? `+${n}Hz` : `${n}Hz`)
async function playPresetBlob(blob: Blob) {
  presetAudio?.pause()
  presetAudio = new Audio(URL.createObjectURL(blob))
  await presetAudio.play()
}
// 克隆音色试听（XTTS 纯 CPU 推理较慢，按钮显示「合成中」）
const clonePreviewingId = ref('')
async function handlePreviewCloneVoice(row: CustomVoice) {
  clonePreviewingId.value = row.id
  try {
    const blob = await previewCustomVoice(row.id)
    await playPresetBlob(blob)
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    clonePreviewingId.value = ''
  }
}
async function loadVoicePresets() {
  voicePresets.value = await listVoicePresets().catch(() => [])
}
async function handlePreviewPreset() {
  if (!presetForm.value.voice) {
    ElMessage.warning('请先选择基础音色')
    return
  }
  presetPreviewing.value = true
  try {
    const blob = await previewPresetVoice({
      name: presetForm.value.name,
      voice: presetForm.value.voice,
      rate: rateStr(presetForm.value.rate),
      pitch: pitchStr(presetForm.value.pitch),
      style: presetForm.value.style,
    })
    await playPresetBlob(blob)
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    presetPreviewing.value = false
  }
}
async function handlePreviewSavedPreset(row: VoicePreset) {
  presetPreviewingId.value = row.id
  try {
    const blob = await previewPresetVoice({
      name: row.name,
      voice: row.voice,
      rate: row.rate,
      pitch: row.pitch,
      volume: row.volume,
      style: row.style,
    })
    await playPresetBlob(blob)
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    presetPreviewingId.value = ''
  }
}
async function handleSavePreset() {
  if (!presetForm.value.name.trim()) {
    ElMessage.warning('请填写音色名称')
    return
  }
  if (!presetForm.value.voice) {
    ElMessage.warning('请选择基础音色')
    return
  }
  presetSaving.value = true
  try {
    const gender = presetBaseVoices.value.find((v) => v.Name === presetForm.value.voice)?.Gender
    const entry = await saveVoicePreset({
      name: presetForm.value.name,
      voice: presetForm.value.voice,
      rate: rateStr(presetForm.value.rate),
      pitch: pitchStr(presetForm.value.pitch),
      style: presetForm.value.style,
      gender,
    })
    ElMessage.success(`已保存：${entry.name}（${entry.id}）`)
    presetForm.value = { name: '', voice: '', rate: 0, pitch: 0, style: '' }
    await loadVoicePresets()
  } catch (err) {
    ElMessage.error((err as Error).message)
  } finally {
    presetSaving.value = false
  }
}
async function handleDeletePreset(id: string) {
  try {
    await deleteVoicePreset(id)
    ElMessage.success('已删除')
    await loadVoicePresets()
  } catch (err) {
    ElMessage.error((err as Error).message)
  }
}
const cloneForm = ref({ baseUrl: '', language: 'zh' })
const savingClone = ref(false)
const testingClone = ref(false)
const cloneTestResult = ref<{ ok: boolean; message: string; latencyMs: number } | null>(null)
const voiceUploading = ref(false)
const uploadError = ref('')
const newVoiceName = ref('')

const filteredVoices = computed(() => {
  const system = voiceList.value
    .filter((voice) => voice.Name.startsWith(selectedLanguage.value))
    .filter((voice) => !voice.Name.startsWith('edge-'))
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
  // 自定义 Edge 音色预设始终可选
  const presets = voicePresets.value.map((p) => ({
    Name: p.id,
    cnName: `🎛️ ${p.name}`,
    Gender: p.gender || '',
    ContentCategories: [] as string[],
    VoicePersonalities: [] as string[],
  }))
  return [...custom, ...presets, ...system]
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
  const system = voiceList.value
    .filter((voice) => !voice.Name.startsWith('edge-'))
    .map((voice) => ({
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
  const presets = voicePresets.value.map((p) => ({
    Name: p.id,
    cnName: `🎛️ ${p.name}`,
    Gender: p.gender || '',
    ContentCategories: [] as string[],
    VoicePersonalities: [] as string[],
  }))
  return [...custom, ...presets, ...system]
})
const hasCharacterVoices = computed(() => !!bookDetail.value?.characterVoices?.length)

// AI 三步流程当前所处的步骤（0 规划 / 1 确认 / 2 生成）
// 规划已用时：每秒随 nowTick 刷新，让长时间单段分析期间页面也有"活着"的反馈
const planningElapsedText = computed(() => {
  if (!bookDetail.value?.planning || !bookDetail.value?.planningStartedAt) return ''
  const secs = Math.max(
    0,
    Math.floor((nowTick.value - new Date(bookDetail.value.planningStartedAt).getTime()) / 1000)
  )
  const m = Math.floor(secs / 60)
  return `（已用时 ${m} 分 ${String(secs % 60).padStart(2, '0')} 秒）`
})

const aiStep = computed(() => {
  if (!bookDetail.value) return 0
  if (bookDetail.value.status === 'completed') return 3
  if (!hasCharacterVoices.value) return 0
  return bookDetail.value.status === 'running' ? 2 : 1
})

function savedVoiceOf(character: string): string | undefined {
  return bookDetail.value?.characterVoices?.find((c) => c.character === character)?.voice
}

function savedVcRefOf(character: string): string {
  return bookDetail.value?.characterVoices?.find((c) => c.character === character)?.vcRef || ''
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
    if (!voices) return
    if (!voicesDirty.value) {
      editingVoices.value = voices.map((c) => ({ ...c }))
      return
    }
    // 规划期间用户已改过音色（脏状态）：只追加新发现的角色、同步对白数，
    // 不覆盖用户已调整的音色/描述
    const known = new Set(editingVoices.value.map((v) => v.character))
    const additions = voices
      .filter((c) => !known.has(c.character))
      .map((c) => ({ ...c }))
    for (const v of editingVoices.value) {
      const latest = voices.find((c) => c.character === v.character)
      if (latest) v.dialog = latest.dialog
    }
    if (additions.length) editingVoices.value = [...editingVoices.value, ...additions]
  },
  { immediate: true }
)

async function handlePlanVoices() {
  if (!bookId.value) return
  planningLoading.value = true
  try {
    await planVoices(bookId.value, voiceAssignMode.value)
    ElMessage.success('已开始逐章通读全书，发现的角色会实时出现在下方角色表中，可随时调整音色')
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
      // vcRef 空值必须规范化为 ''（解绑信号）：undefined 会被 JSON 序列化丢弃，
      // 后端按"未传=保留原绑定"处理，导致清空换声源后旧绑定复活
      editingVoices.value.map((v) => ({
        character: v.character,
        voice: v.voice,
        vcRef: v.vcRef ?? '',
      }))
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
  const index = filteredEditingVoices.value.findIndex((r) => r.character === row.character)
  if (index < 0) return
  await previewPlayerLoad(index)
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
    ...voicePresets.value.map((p) => p.id),
    ...system.map((v) => v.Name),
  ]
  if (!candidates.includes(selectedVoice.value)) {
    selectedVoice.value =
      customVoices.value[0]?.voice || voicePresets.value[0]?.id || system[0]?.Name || ''
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
    if (localStorage.getItem(LAST_BOOK_KEY) === id) localStorage.removeItem(LAST_BOOK_KEY)
    // 删除的是当前打开的书时，退回新建视图
    if (bookId.value === id) backToUpload()
    await refreshBooks()
  } catch (error) {
    ElMessage.error((error as Error).message || '删除失败')
  }
}

// ===== 章节选择（进度页）=====
const selectionDialogVisible = ref(false)
const selectionSaving = ref(false)
const selectionTableRef = ref()
const selectionRows = ref<Record<string, unknown>[]>([])

function selectionSelectable(row: { status: string }) {
  return row.status !== 'done' && row.status !== 'processing'
}

function openSelectionDialog() {
  selectionDialogVisible.value = true
}

function handleProgressSelectionChange(rows: Record<string, unknown>[]) {
  selectionRows.value = rows
}

async function confirmSelection() {
  if (!bookId.value || !bookDetail.value) return
  const wanted = new Set(selectionRows.value.map((r) => r.index as number))
  selectionSaving.value = true
  try {
    const indexes = bookDetail.value.chapters
      .filter((c) => c.status !== 'done' && c.status !== 'processing' && wanted.has(c.index))
      .map((c) => c.index)
    await updateChapterSelection(bookId.value, indexes)
    selectionDialogVisible.value = false
    ElMessage.success('章节选择已更新')
    await refreshDetail()
  } catch (error) {
    ElMessage.error((error as Error).message || '保存章节选择失败')
  } finally {
    selectionSaving.value = false
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
    // 仅保存本卡片管理的字段（load 时展开进表单的 speakersDir 等后端字段不回写）
    await saveCloneSettings({
      baseUrl: cloneForm.value.baseUrl,
      language: cloneForm.value.language,
    })
    cloneTestResult.value = null
    ElMessage.success('克隆服务配置已保存')
  } catch (error) {
    ElMessage.error((error as Error).message || '保存失败')
  } finally {
    savingClone.value = false
  }
}

async function handleTestClone() {
  testingClone.value = true
  cloneTestResult.value = null
  try {
    const payload: Record<string, string> = {}
    if (cloneForm.value.baseUrl.trim()) payload.baseUrl = cloneForm.value.baseUrl.trim()
    if (cloneForm.value.language.trim()) payload.language = cloneForm.value.language.trim()
    const r = await testCloneSettings(payload)
    cloneTestResult.value = r
    if (r.ok) ElMessage.success('克隆服务连接成功')
  } catch (error) {
    ElMessage.error((error as Error).message || '测试失败')
  } finally {
    testingClone.value = false
  }
}

async function handleUploadVoice(file: UploadFile) {
  const raw = file.raw
  if (!raw) return
  const rawName = (raw.name || '').trim()
  const ext = rawName.slice(rawName.lastIndexOf('.')) || '.wav'
  if (!/\.(wav|mp3|m4a|flac|ogg)$/i.test(rawName)) {
    ElMessage.error('仅支持 wav/mp3/m4a/flac/ogg 音频！')
    return
  }
  // 名称留空时默认使用文件名（去扩展名）
  const voiceName = newVoiceName.value.trim() || rawName.replace(/\.[^.]+$/, '')
  if (!voiceName) {
    ElMessage.error('无法确定音色名称，请手动填写')
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
    await uploadCustomVoice(voiceName, dataUrl.slice(dataUrl.indexOf(',') + 1), ext)
    ElMessage.success(`自定义音色「${voiceName}」已上传`)
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
        voiceEngine: voiceMode.value === 'llm' ? voiceEngine.value : 'edge',
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
    // 同步该书的配音引擎；换声引擎需拉取换声源列表（参考音频 / RVC 模型）
    voiceEngine.value = bookDetail.value.params.voiceEngine || 'edge'
    if (isVcEngineBook.value) {
      void ensureVcInfo()
    }
    // 记住最后打开的书：页面刷新后自动恢复到详情视图，规划/生成进度不丢
    localStorage.setItem(LAST_BOOK_KEY, id)
    startPolling()
  } catch (error) {
    ElMessage.error((error as Error).message || '打开有声书失败')
  }
}

function backToUpload() {
  stopPolling()
  bookId.value = null
  bookDetail.value = null
  // 主动返回列表视为退出详情视图，刷新后不再强制恢复
  localStorage.removeItem(LAST_BOOK_KEY)
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

/** 单章重新生成：覆盖该章节音频（用于修复缺段/重复或应用新音色后单独刷新） */
const regeneratingIndex = ref<number | null>(null)
async function handleRegenerateChapter(row: BookChapter) {
  if (!bookId.value) return
  try {
    await ElMessageBox.confirm(
      `确定重新生成「${row.title}」吗？该章节现有音频与字幕将被覆盖。`,
      '重新生成章节',
      { type: 'warning', confirmButtonText: '重新生成', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  regeneratingIndex.value = row.index
  try {
    await regenerateChapter(bookId.value, row.index)
    ElMessage.success('已开始重新生成该章节')
    await refreshDetail()
  } catch (error) {
    ElMessage.error((error as Error).message || '重新生成失败')
  } finally {
    regeneratingIndex.value = null
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

/** 全文重新生成：全部章节重新合成并覆盖现有音频 */
const regenerateAllLoading = ref(false)
async function handleRegenerateAll(command: 'cached' | 'fresh') {
  if (!bookId.value || !bookDetail.value) return
  const fresh = command === 'fresh'
  const total = bookDetail.value.chapters.filter((c) => c.status !== 'skipped').length
  try {
    await ElMessageBox.confirm(
      fresh
        ? `将忽略缓存，强制重新合成全部 ${total} 章，并覆盖现有音频与字幕。耗时较长（每章都完整重做），确定继续吗？`
        : `将使用当前音色/换声源设置重新生成全部 ${total} 章并覆盖现有音频。未变化的片段会复用缓存（较快），确定继续吗？`,
      '重新生成全书',
      { type: 'warning', confirmButtonText: '开始重新生成', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  regenerateAllLoading.value = true
  try {
    await regenerateAll(bookId.value, fresh)
    ElMessage.success('已开始全文重新生成')
    await refreshDetail()
  } catch (error) {
    ElMessage.error((error as Error).message || '重新生成失败')
  } finally {
    regenerateAllLoading.value = false
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
  const index = playableChapters.value.findIndex((c) => c.index === row.index)
  if (index < 0) return
  void chapterPlayerLoad(index)
}

async function copyChapterError(row: { error?: string | null }) {
  if (!row.error) return
  try {
    await navigator.clipboard.writeText(row.error)
    ElMessage.success('错误信息已复制')
  } catch {
    ElMessage.error('复制失败，请手动选择文本复制')
  }
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

// LLM 连通性测试：用表单当前值发起最小真实调用（Key 留空则用已保存/环境变量里的密钥）
const llmTesting = ref(false)
const llmTestResult = ref<LlmTestResult | null>(null)
async function handleTestLlm() {
  llmTesting.value = true
  llmTestResult.value = null
  try {
    const payload: Record<string, string> = {}
    if (llmForm.value.baseUrl.trim()) payload.baseUrl = llmForm.value.baseUrl.trim()
    if (llmForm.value.model.trim()) payload.model = llmForm.value.model.trim()
    if (llmForm.value.apiKey.trim()) payload.apiKey = llmForm.value.apiKey.trim()
    llmTestResult.value = await testLlmSettings(payload)
  } catch (error) {
    ElMessage.error((error as Error).message || '测试失败')
  } finally {
    llmTesting.value = false
  }
}

onMounted(async () => {
  loadVoiceList()
  refreshBooks()
  loadLlmSettings()
  loadCustomVoices()
  loadVoicePresets()
  loadCloneSettings()
  tickTimer = setInterval(() => (nowTick.value = Date.now()), 1000)
  // 恢复进度视图：优先回到最后打开的书；没有记录时若有书正在规划/生成，自动打开它
  // （规划在服务端进行，刷新页面不会中断，恢复后轮询继续展示 planningDetail 进度）
  await refreshBooks()
  const lastId = localStorage.getItem(LAST_BOOK_KEY)
  const targetId =
    lastId ||
    books.value.find((b) => b.planning || b.status === 'running')?.id ||
    ''
  if (targetId) {
    try {
      bookDetail.value = await getBook(targetId)
      bookId.value = targetId
      localStorage.setItem(LAST_BOOK_KEY, targetId)
      startPolling()
    } catch {
      // 书已被删除或 ID 失效，清除记录回到新建视图
      localStorage.removeItem(LAST_BOOK_KEY)
    }
  }
})
onBeforeUnmount(() => {
  stopPolling()
  if (tickTimer) {
    clearInterval(tickTimer)
    tickTimer = null
  }
  previewAudioEl?.pause()
  chapterAudioEl?.pause()
  presetAudio?.pause()
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
  .batch-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
    padding: 6px 10px;
    background: rgba(64, 158, 255, 0.08);
    border-radius: 6px;
    .batch-count {
      color: #409eff;
      font-size: 12px;
      white-space: nowrap;
    }
    .batch-select {
      width: 210px;
    }
  }
  .character-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
    h3 {
      margin: 0;
      font-size: 15px;
    }
    .character-search {
      width: 200px;
      margin-left: auto;
      margin-right: 10px;
    }
  }
  .voice-name {
    color: #999;
    font-size: 12px;
  }
}
.inline-player {
  margin-top: 14px;
  padding: 10px 14px;
  background: rgba(255, 255, 255, 0.7);
  border-radius: 10px;
  .player-row {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .player-tag {
    flex-shrink: 0;
    padding: 2px 8px;
    background: #409eff;
    color: #fff;
    border-radius: 4px;
    font-size: 12px;
    &.player-tag-preview {
      background: #e6a23c;
    }
  }
  .player-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    color: #333;
  }
  .player-time {
    flex-shrink: 0;
    color: #999;
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .player-slider {
    margin: 6px 0 0;
  }
  .player-subtitle {
    margin-top: 6px;
    color: #666;
    font-size: 12px;
    line-height: 1.6;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
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
