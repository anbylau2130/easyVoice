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
        title="用文字描述创造声音（性别 / 年龄 / 音调 / 风格），无需参考音频"
        description="试听会随机生成符合描述的不同人声；点「保存」时会把当前声音固化为声纹样本，之后在有声书（OmniVoice 引擎）中由 AI 按角色性格与性别分配，且全书同一角色声音保持一致。CPU 部署合成较慢（每次约 1~3 分钟），请耐心等待。"
      />
    </section>

    <!-- 设计与试听 -->
    <section class="section">
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
      <div class="config-item">
        <label>试听文本</label>
        <el-input
          v-model="previewText"
          type="textarea"
          :rows="2"
          maxlength="300"
          placeholder="留空则使用内置试音句"
        />
      </div>

      <h3 class="block-title">② 试听效果</h3>
      <div class="player-row">
        <audio ref="previewAudioRef" controls :src="previewUrl || undefined" class="design-audio" />
        <el-button
          type="primary"
          :loading="previewing"
          :disabled="!instruct.trim()"
          @click="handlePreview"
        >
          {{ previewing ? '合成中（约 1~3 分钟）…' : '🎲 随机试听' }}
        </el-button>
      </div>
      <p class="settings-tip">同一描述每次试听会生成不同人声；听到满意的声音后立即保存固化。</p>

      <h3 class="block-title">③ 保存为设计音色</h3>
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
          :disabled="!instruct.trim() || !design.name.trim()"
          @click="handleSave"
        >
          {{ saving ? '生成声纹中（约 1~3 分钟）…' : '💾 生成声纹并保存' }}
        </el-button>
      </div>
    </section>

    <!-- 已保存的设计 -->
    <section class="section">
      <div class="page-head">
        <h3 class="block-title no-margin">已保存的设计音色</h3>
        <el-button size="small" :loading="loadingList" @click="loadDesigns">刷新</el-button>
      </div>
      <el-table :data="designs" size="small" empty-text="还没有设计音色，先在上方创建一个吧">
        <el-table-column label="名称" min-width="140">
          <template #default="{ row }">🎨 {{ row.name }}</template>
        </el-table-column>
        <el-table-column prop="instruct" label="声音描述" min-width="220" show-overflow-tooltip />
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
        <el-table-column label="操作" width="260" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" size="small" @click="playSample(row)">
              ▶ 试听声纹
            </el-button>
            <el-button
              link
              type="warning"
              size="small"
              :disabled="rerollingName === row.name"
              @click="handleReroll(row)"
            >
              {{ rerollingName === row.name ? '重摇中…' : '🎲 重摇声纹' }}
            </el-button>
            <el-button link type="danger" size="small" @click="handleDelete(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
      <p class="settings-tip">
        设计音色保存在 voices/ 目录（omni-前缀声纹），也是合法的「换声源」；创建有声书选择
        OmniVoice 引擎并规划角色时，AI 会依据角色性格与性别自动分配这些音色。
      </p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage, ElMessageBox } from 'element-plus'
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
const previewing = ref(false)
const saving = ref(false)
const loadingList = ref(false)
const rerollingName = ref('')
const designs = ref<OmniDesign[]>([])
const previewUrl = ref('')
const previewAudioRef = ref<HTMLAudioElement>()

// 选择器变化时自动重组描述（手动编辑过的内容在选择器变化后被覆盖）
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
  // src 更新后自动播放
  requestAnimationFrame(() => void previewAudioRef.value?.play().catch(() => {}))
}

async function handlePreview() {
  if (!instruct.value.trim()) return
  previewing.value = true
  try {
    const blob = await previewOmniDesign({
      instruct: instruct.value.trim(),
      text: previewText.value.trim() || undefined,
    })
    swapAudioBlob(blob)
    ElMessage.success('试听已生成')
  } catch (error) {
    ElMessage.error((error as Error).message || '试听失败')
  } finally {
    previewing.value = false
  }
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
  if (!name || !instruct.value.trim()) return
  saving.value = true
  try {
    const saved = await createOmniDesign({
      name,
      instruct: instruct.value.trim(),
      gender: design.value.gender,
    })
    ElMessage.success(`「${saved.name}」已保存，声纹固化完成`)
    design.value.name = ''
    await loadDesigns()
  } catch (error) {
    ElMessage.error((error as Error).message || '保存失败')
  } finally {
    saving.value = false
  }
}

async function playSample(row: OmniDesign) {
  try {
    const blob = await fetchOmniDesignSample(row.name)
    swapAudioBlob(blob)
  } catch (error) {
    ElMessage.error((error as Error).message || '获取声纹样本失败')
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
</style>
