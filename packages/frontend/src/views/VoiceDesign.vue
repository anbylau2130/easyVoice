<template>
  <div class="design-container">
    <section class="section">
      <div class="page-head">
        <el-button size="small" @click="router.push('/book')">← 返回有声书</el-button>
        <h2 class="section-title">🎨 OmniVoice 音色设计</h2>
      </div>
      <el-alert
        type="info"
        :closable="false"
        title="两种方式创造音色：文字描述生成，或直接上传一段音频"
        description="流程：调整参数/上传音频 → 生成声纹并试听 → 满意后命名保存到列表。保存的声音就是试听到的声音，参数随声纹一起保存，随时可编辑微调重新设计。CPU 部署合成较慢（每次约 1~3 分钟），请耐心等待。"
      />
    </section>

    <!-- 设计与试听 -->
    <section class="section">
      <el-radio-group v-model="mode" class="mode-switch">
        <el-radio-button value="instruct">✍️ 参数设计</el-radio-button>
        <el-radio-button value="audio">🎙️ 上传音频</el-radio-button>
      </el-radio-group>

      <!-- 参数设计 -->
      <template v-if="mode === 'instruct'">
        <h3 class="block-title">① 描述声音</h3>
        <div class="config-grid">
          <div class="config-item">
            <label>性别（必选，供 AI 按角色性别分配）</label>
            <el-radio-group v-model="design.gender">
              <el-radio value="female">女</el-radio>
              <el-radio value="male">男</el-radio>
            </el-radio-group>
          </div>
          <div class="config-item">
            <label>年龄段</label>
            <el-select v-model="design.age" clearable placeholder="不限">
              <el-option v-for="a in AGES" :key="a" :label="a" :value="a" />
            </el-select>
          </div>
          <div class="config-item">
            <label>音调</label>
            <el-select v-model="design.pitch" clearable placeholder="不限">
              <el-option v-for="p in PITCHES" :key="p" :label="p" :value="p" />
            </el-select>
          </div>
          <div class="config-item">
            <label>风格</label>
            <el-checkbox v-model="design.whisper">耳语</el-checkbox>
          </div>
          <div class="config-item">
            <label>方言（有声书建议保持普通话）</label>
            <el-select v-model="design.dialect" clearable placeholder="标准普通话">
              <el-option v-for="d in DIALECTS" :key="d" :label="d" :value="d" />
            </el-select>
          </div>
        </div>
        <div class="config-item instruct-line">
          <label>声音描述（可手动微调）</label>
          <el-input v-model="instruct" placeholder="如：女，青年，低音调" maxlength="200" />
        </div>
        <div class="config-item instruct-line">
          <label>试听文本（按这段文字生成声纹试听）</label>
          <el-input
            v-model="previewText"
            type="textarea"
            :rows="2"
            maxlength="300"
            placeholder="输入想听到的内容；留空则使用内置试音句"
          />
        </div>
      </template>

      <!-- 上传音频 -->
      <template v-else>
        <h3 class="block-title">① 上传参考音频</h3>
        <el-alert
          type="warning"
          :closable="false"
          class="upload-tip"
          title="上传一段清晰的单一说话人音频（wav/mp3 等均可），3~10 秒效果最佳，超过 10 秒会自动裁剪"
        />
        <div class="config-item">
          <input
            ref="fileInputRef"
            type="file"
            accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg"
            class="file-input"
            @change="handleFileChange"
          />
          <el-button :icon="Upload" @click="fileInputRef?.click()">
            {{ uploadFile ? `已选择：${uploadFile.name}` : '选择音频文件' }}
          </el-button>
          <el-button v-if="uploadFile" link type="danger" @click="clearUpload">清除</el-button>
        </div>
      </template>

      <!-- 试听 -->
      <h3 class="block-title">② {{ mode === 'instruct' ? '生成声纹并试听' : '试听音频' }}</h3>
      <div class="player-row">
        <audio ref="previewAudioRef" controls :src="previewUrl || undefined" class="design-audio" />
        <el-button
          v-if="mode === 'instruct'"
          type="primary"
          :loading="generating"
          :disabled="!instruct.trim()"
          @click="handleGenerateTexture"
        >
          {{ generating ? '生成声纹中（约 1~3 分钟）…' : textureBlob ? '🎲 重新生成声纹' : '🎲 生成声纹并试听' }}
        </el-button>
      </div>
      <p v-if="mode === 'instruct'" class="settings-tip">
        同一描述每次生成的是不同人声；试听满意后立即保存，保存的就是当前听到的声音。
      </p>

      <!-- 保存 -->
      <h3 class="block-title">③ 命名并保存声纹</h3>
      <div class="player-row">
        <el-input
          v-model="design.name"
          placeholder="音色名称，如：温柔女声"
          maxlength="40"
          class="name-input"
        />
        <el-button
          type="success"
          :loading="saving"
          :disabled="!canSave"
          @click="handleSave"
        >
          {{ saving ? '保存中…' : '💾 保存声纹到列表' }}
        </el-button>
        <el-button v-if="editingName" @click="cancelEdit">取消编辑</el-button>
      </div>
      <p v-if="editingName" class="settings-tip edit-hint">
        ✏️ 正在编辑「{{ editingName }}」：调整后保存将覆盖其声纹与参数。
      </p>
    </section>

    <!-- 已保存的设计 -->
    <section class="section">
      <div class="page-head">
        <h3 class="block-title no-margin">已保存的设计音色</h3>
        <el-button size="small" :loading="loadingList" @click="loadDesigns">刷新</el-button>
      </div>
      <el-table :data="designs" size="small" empty-text="还没有设计音色，先在上方创建一个吧">
        <el-table-column label="名称" min-width="130">
          <template #default="{ row }">🎨 {{ row.name }}</template>
        </el-table-column>
        <el-table-column prop="instruct" label="声音描述" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.instruct || '（来自上传音频）' }}</template>
        </el-table-column>
        <el-table-column label="性别" width="70">
          <template #default="{ row }">
            <el-tag size="small" :type="row.gender === 'male' ? 'primary' : 'danger'">
              {{ row.gender === 'male' ? '男' : row.gender === 'female' ? '女' : '未定' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="创建时间" width="110">
          <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column label="操作" width="320" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              size="small"
              :disabled="sampleLoadingName === row.name"
              @click="playSample(row)"
            >
              {{ sampleLoadingName === row.name ? '合成中…' : '▶ 试听效果' }}
            </el-button>
            <el-button link type="success" size="small" @click="handleEdit(row)">✏️ 编辑</el-button>
            <el-button
              link
              type="warning"
              size="small"
              :disabled="rerollingName === row.name || !row.instruct"
              @click="handleReroll(row)"
            >
              {{ rerollingName === row.name ? '重摇中…' : '🎲 重摇' }}
            </el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="settings-tip">
        设计音色保存在 voices/ 目录（omni-前缀声纹），也是合法的「换声源」；创建有声书选择
        OmniVoice 引擎并规划角色时，AI 会依据角色性格与性别自动分配这些音色（生成模式会为角色
        现场设计新音色，匹配模式从本列表中挑选）。
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Upload } from '@element-plus/icons-vue'
import {
  createOmniDesign,
  deleteOmniDesign,
  fetchOmniDesignSample,
  listOmniDesigns,
  previewOmniDesign,
  type OmniDesign,
} from '@/api/voices'

const router = useRouter()

// 属性词汇与 OmniVoice 官方 voice-design 词表一致（中文直接可用）
const AGES = ['儿童', '少年', '青年', '中年', '老年']
const PITCHES = ['极低音调', '低音调', '中音调', '高音调', '极高音调']
const DIALECTS = ['河南话', '陕西话', '四川话', '贵州话', '云南话', '桂林话', '济南话', '石家庄话', '甘肃话', '宁夏话', '青岛话', '东北话']

const mode = ref<'instruct' | 'audio'>('instruct')
const design = ref({
  gender: 'female' as 'female' | 'male',
  age: '',
  pitch: '',
  whisper: false,
  dialect: '',
  name: '',
})
const instruct = ref('')
const previewText = ref('')
const generating = ref(false)
const saving = ref(false)
const loadingList = ref(false)
const rerollingName = ref('')
const sampleLoadingName = ref('')
const designs = ref<OmniDesign[]>([])
const previewUrl = ref('')
const previewAudioRef = ref<HTMLAudioElement>()
// 生成声纹后暂存：保存的就是试听到的这段声音
const textureBlob = ref<Blob | null>(null)
// 上传音频
const fileInputRef = ref<HTMLInputElement>()
const uploadFile = ref<File | null>(null)
const editingName = ref('')

const canSave = computed(() => {
  if (!design.value.name.trim()) return false
  if (mode.value === 'instruct') return Boolean(textureBlob.value)
  return Boolean(uploadFile.value)
})

const instructFromSelectors = computed(() => {
  const parts = [
    design.value.gender === 'female' ? '女' : '男',
    design.value.age,
    design.value.pitch,
    design.value.whisper ? '耳语' : '',
    design.value.dialect,
  ]
  return parts.filter(Boolean).join('，')
})
watch(
  instructFromSelectors,
  (value) => {
    if (value) instruct.value = value
  },
  { immediate: true }
)

function swapAudioBlob(blob: Blob) {
  const url = URL.createObjectURL(blob)
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = url
  requestAnimationFrame(() => void previewAudioRef.value?.play().catch(() => {}))
}

/** 参数设计：按当前参数生成声纹并试听（保存的就是这段声音） */
async function handleGenerateTexture() {
  if (!instruct.value.trim()) return
  generating.value = true
  try {
    const blob = await previewOmniDesign({
      instruct: instruct.value.trim(),
      text: previewText.value.trim() || undefined,
    })
    textureBlob.value = blob
    swapAudioBlob(blob)
    ElMessage.success('声纹已生成，试听满意后命名保存')
  } catch (error) {
    textureBlob.value = null
    ElMessage.error((error as Error).message || '声纹生成失败')
  } finally {
    generating.value = false
  }
}

function handleFileChange(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  if (!file) return
  uploadFile.value = file
  swapAudioBlob(file)
}

function clearUpload() {
  uploadFile.value = null
  if (fileInputRef.value) fileInputRef.value.value = ''
}

async function loadDesigns() {
  loadingList.value = true
  try {
    designs.value = await listOmniDesigns()
  } catch (error) {
    ElMessage.error((error as Error).message || '获取设计音色失败')
  } finally {
    loadingList.value = false
  }
}

async function handleSave() {
  const name = design.value.name.trim()
  if (!name) return
  if (mode.value === 'instruct' && !textureBlob.value) {
    ElMessage.warning('请先「生成声纹并试听」，满意后再保存')
    return
  }
  if (mode.value === 'audio' && !uploadFile.value) {
    ElMessage.warning('请先选择音频文件')
    return
  }
  saving.value = true
  try {
    const audio = mode.value === 'instruct' ? textureBlob.value! : uploadFile.value!
    const saved = await createOmniDesign({
      name,
      instruct: mode.value === 'instruct' ? instruct.value.trim() : '',
      gender: design.value.gender,
      audio,
    })
    ElMessage.success(`「${saved.name}」已保存，声纹固化完成`)
    cancelEdit()
    design.value.name = ''
    await loadDesigns()
  } catch (error) {
    ElMessage.error((error as Error).message || '保存失败')
  } finally {
    saving.value = false
  }
}

/** 编辑已有设计：载入其参数，微调后重新生成声纹并保存（同名覆盖） */
function handleEdit(row: OmniDesign) {
  editingName.value = row.name
  mode.value = 'instruct'
  design.value.name = row.name
  design.value.gender = row.gender === 'male' ? 'male' : 'female'
  if (row.instruct) {
    instruct.value = row.instruct
    // 反推选择器状态（尽力匹配词表，匹配不上保持手写描述）
    const parts = row.instruct.split(/[,，]/).map((s) => s.trim())
    design.value.gender = parts[0] === '男' ? 'male' : 'female'
    design.value.age = AGES.find((a) => parts.includes(a)) || ''
    design.value.pitch = PITCHES.find((p) => parts.includes(p)) || ''
    design.value.whisper = parts.includes('耳语')
    design.value.dialect = DIALECTS.find((d) => parts.includes(d)) || ''
  }
  textureBlob.value = null
  window.scrollTo({ top: 0, behavior: 'smooth' })
  ElMessage.info(`已载入「${row.name}」的参数，微调后重新生成声纹并保存即可覆盖`)
}

function cancelEdit() {
  editingName.value = ''
  textureBlob.value = null
}

async function playSample(row: OmniDesign) {
  // 首次需按声纹现场合成试听语音（CPU 数分钟），结果缓存后秒回
  sampleLoadingName.value = row.name
  try {
    const blob = await fetchOmniDesignSample(row.name)
    swapAudioBlob(blob)
    ElMessage.success(`「${row.name}」试听已生成`)
  } catch (error) {
    ElMessage.error((error as Error).message || '试听生成失败')
  } finally {
    sampleLoadingName.value = ''
  }
}

async function handleReroll(row: OmniDesign) {
  rerollingName.value = row.name
  try {
    await createOmniDesign({ name: row.name, instruct: row.instruct, gender: row.gender })
    ElMessage.success(`「${row.name}」声纹已重摇`)
    await loadDesigns()
  } catch (error) {
    ElMessage.error((error as Error).message || '重摇声纹失败')
  } finally {
    rerollingName.value = ''
  }
}

async function handleDelete(row: OmniDesign) {
  try {
    await ElMessageBox.confirm(
      `删除设计音色「${row.name}」？已在有声书中使用该音色的角色将无法再合成（生成时会回落 Edge 音色）。`,
      '删除确认',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' }
    )
  } catch {
    return
  }
  try {
    await deleteOmniDesign(row.name)
    ElMessage.success('已删除')
    if (editingName.value === row.name) cancelEdit()
    await loadDesigns()
  } catch (error) {
    ElMessage.error((error as Error).message || '删除失败')
  }
}

function formatTime(ts?: number) {
  if (!ts) return '-'
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(() => {
  void loadDesigns()
})
</script>

<style scoped>
.design-container {
  max-width: 1000px;
  margin: 0 auto;
  padding: 16px 0 40px;
}
.section {
  background: rgba(255, 255, 255, 0.92);
  border-radius: 12px;
  padding: 20px;
  margin-bottom: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.04);
}
.page-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.section-title {
  font-size: 20px;
  margin: 0;
}
.block-title {
  font-size: 15px;
  margin: 14px 0 10px;
}
.block-title.no-margin {
  margin-top: 0;
}
.mode-switch {
  margin-bottom: 16px;
}
.upload-tip {
  margin-bottom: 12px;
}
.config-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 16px 24px;
}
.config-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.config-item label {
  font-size: 13px;
  color: #666;
}
.config-item .el-select {
  width: 180px;
}
.instruct-line {
  margin-top: 14px;
  max-width: 560px;
}
.file-input {
  display: none;
}
.player-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.design-audio {
  height: 40px;
  min-width: 320px;
}
.name-input {
  width: 260px;
}
.settings-tip {
  font-size: 12px;
  color: #999;
  margin-top: 10px;
  line-height: 1.7;
}
.edit-hint {
  color: #e6a23c;
}
</style>
