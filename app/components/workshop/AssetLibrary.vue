<script setup lang="ts">
/**
 * 素材库(Asset Library)面板 —— 列出「可拖拽加载到小镇」的角色模型,并支持上传/删除。
 *
 * 交互:
 *  - 每张模型卡可拖拽:拖起时把 assetId 写入 dataTransfer,小镇地图作为放进区域,
 *    落下时 TownScene.dropModelOnWorld() 就近换装或落点生成居民(已实现)。
 *  - 「绑定」:选中某 agent → 点模型卡上的绑定钮,写 PATCH modelRef(经 useCharacterAssets.bind)。
 *  - 上传:选择本地图片(multipart)→ 刷新清单。
 *  - 删除:引删保护(仍被绑定 → 提示 used>0,不硬删)。
 */

import { useCharacterAssets } from '@/app/composables/workshop/useCharacterAssets'

const assets = useCharacterAssets()
const props = defineProps<{
  /** 当前聚焦 channelId(绑定用) */
  channelId?: string
  /** 可选:提供 agent 列表供"绑定到角色" */
  agents?: Array<{ agentId: string, name: string, role: string }>
}>()

// 拖起:把模型 id 交给 dataTransfer(HTML5 DnD)
function onDragStart(e: DragEvent, id: string): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-aw-model', id)
  e.dataTransfer.setData('text/plain', id)
  e.dataTransfer.effectAllowed = 'copy'
}

function onDragEnd(e: DragEvent): void {
  void e
}

// ---------- 上传 ----------
const uploading = ref(false)
const uploadError = ref('')
const uploadFile = ref<File | null>(null)
const onPickFile = (e: Event): void => {
  const input = e.target as HTMLInputElement
  uploadFile.value = input.files?.[0] ?? null
  uploadError.value = ''
}
async function doUpload(): Promise<void> {
  const f = uploadFile.value
  if (!f) {
    uploadError.value = '请先选择图片文件'
    return
  }
  uploading.value = true
  uploadError.value = ''
  try {
    await assets.upload(f, { kind: 'sheet', frameWidth: 48, frameHeight: 88, frames: 4 })
    uploadFile.value = null
  }
  catch (err) {
    uploadError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    uploading.value = false
  }
}

// ---------- 删除(引删保护) ----------
const deletingId = ref('')
const deleteMsg = ref('')
async function doRemove(id: string): Promise<void> {
  deletingId.value = id
  deleteMsg.value = ''
  try {
    const res = await assets.remove(id)
    deleteMsg.value = res.used > 0
      ? `该模型仍被 ${res.used} 个角色使用,未删除`
      : '已删除'
  }
  catch (err) {
    deleteMsg.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    deletingId.value = ''
  }
}

// ---------- 绑定到角色 ----------
const bindAgentId = ref('')
const bindMsg = ref('')
async function doBind(id: string): Promise<void> {
  const agentId = bindAgentId.value
  if (!props.channelId || !agentId) {
    bindMsg.value = props.agents?.length ? '请先选择角色' : '无可绑定的角色(未选择频道)'
    return
  }
  bindMsg.value = ''
  try {
    await assets.bind(props.channelId, agentId, id)
    bindMsg.value = '已绑定'
  }
  catch (err) {
    bindMsg.value = err instanceof Error ? err.message : String(err)
  }
}
</script>

<template>
  <aside class="asset-lib">
    <div class="lib-head">
      <span class="head-dot" />
      <span class="head-title">模型库</span>
      <span class="head-hint">拖到地图上任一角色即换装</span>
    </div>

    <!-- 上传区 -->
    <div class="upload-box">
      <label class="upload-row">
        <input
          type="file"
          accept="image/png,image/webp,image/gif"
          class="file-input"
          @change="onPickFile"
        >
        <span class="upload-name">{{ uploadFile?.name || '选择贴图(png/webp/gif)' }}</span>
      </label>
      <button
        class="upload-btn"
        :disabled="uploading"
        @click="doUpload"
      >
        {{ uploading ? '上传中…' : '上传模型' }}
      </button>
      <span
        v-if="uploadError"
        class="mini-err"
      >{{ uploadError }}</span>
    </div>

    <!-- 绑定区 -->
    <div
      v-if="agents && agents.length"
      class="bind-box"
    >
      <span class="bind-label">绑定到角色:</span>
      <select
        v-model="bindAgentId"
        class="bind-select"
      >
        <option value="">
          选择…
        </option>
        <option
          v-for="a in agents"
          :key="a.agentId"
          :value="a.agentId"
        >
          {{ a.name }}({{ a.role }})
        </option>
      </select>
    </div>

    <div class="lib-grid">
      <div
        v-for="m in assets.models"
        :key="m.id"
        class="model-card"
        :data-model-id="m.id"
        draggable="true"
        :title="m.hint || `拖到地图上给角色换装 · ${m.name}`"
        @dragstart="onDragStart($event, m.id)"
        @dragend="onDragEnd"
      >
        <template v-if="m.kind === 'glb' || m.kind === 'dev'">
          <span
            class="model-img glb"
            :class="{ dev: m.kind === 'dev' }"
          >
            <span class="glb-cube">{{ m.kind === 'dev' ? '⚙' : '◈' }}</span>
          </span>
        </template>
        <img
          v-else
          :src="m.file"
          :alt="m.name"
          class="model-img"
          draggable="false"
        >
        <span class="model-name">{{ m.name }}</span>
        <span class="model-badge">{{ m.kind === 'dev' ? '设备' : m.kind === 'glb' ? '3D .glb' : `${m.frames}帧` }} · {{ m.applied ? '使用中' : '闲置' }}</span>
        <div class="card-actions">
          <button
            v-if="agents && agents.length"
            class="card-btn"
            @click="doBind(m.id)"
          >
            绑定
          </button>
          <button
            class="card-btn danger"
            :disabled="deletingId === m.id"
            @click="doRemove(m.id)"
          >
            {{ deletingId === m.id ? '…' : '删' }}
          </button>
        </div>
      </div>
      <div
        v-if="!assets.loaded"
        class="model-card loading"
      >
        <span class="loading-dot" />
        载入模型库…
      </div>
      <div
        v-else-if="assets.models.length === 0"
        class="model-card empty"
      >
        暂无模型
      </div>
    </div>

    <span
      v-if="deleteMsg || bindMsg"
      class="mini-msg"
    >{{ deleteMsg || bindMsg }}</span>
  </aside>
</template>

<style scoped>
.asset-lib {
  display: flex;
  flex-direction: column;
  gap: 9px;
  width: 172px;
  flex: none;
  padding: 10px 12px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-highlight);
}
.lib-head {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 12px;
  color: var(--ink-soft);
}
.head-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.head-title { font-weight: 700; color: var(--ink); }
.head-hint { margin-left: auto; font-size: 10px; color: var(--ink-faint); white-space: nowrap; }

.upload-box { display: flex; flex-direction: column; gap: 5px; padding: 6px; background: var(--paper-raised); border: 1px solid var(--line); border-radius: var(--radius-panel-sm); }
.upload-row { display: flex; align-items: center; gap: 4px; font-size: 11px; color: var(--ink-soft); cursor: pointer; }
.file-input { display: none; }
.upload-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upload-btn { padding: 3px 8px; font-size: 11px; font-weight: 600; color: var(--on-av); background: var(--accent); border: 0; border-radius: var(--radius-chip); cursor: pointer; }
.upload-btn:disabled { opacity: 0.5; cursor: default; }

.bind-box { display: flex; flex-direction: column; gap: 4px; padding: 6px; background: var(--paper-raised); border: 1px solid var(--line); border-radius: var(--radius-panel-sm); }
.bind-label { font-size: 10px; color: var(--ink-faint); }
.bind-select { font-size: 11px; padding: 3px; border: 1px solid var(--line); border-radius: var(--radius-chip); background: var(--paper); color: var(--ink); }

.lib-grid { display: flex; flex-direction: column; gap: 8px; }
.model-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 6px 6px;
  cursor: grab;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
  transition: border-color var(--transition-fast), transform var(--transition-fast), box-shadow var(--transition-fast);
}
.model-card:hover { border-color: var(--accent); box-shadow: var(--shadow-float); transform: translateY(-1px); }
.model-card:active { cursor: grabbing; }
.model-img { width: 46px; height: 68px; object-fit: contain; image-rendering: pixelated; pointer-events: none; }
.model-img.glb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, rgba(128,180,196,0.35), rgba(64,96,120,0.2));
  border: 1px solid rgba(150,200,220,0.35);
  border-radius: var(--radius-panel-sm);
}
.glb-cube { font-size: 26px; color: var(--accent); }
.model-img.glb.dev {
  background: linear-gradient(160deg, rgba(239,181,106,0.4), rgba(120,90,40,0.2));
  border-color: rgba(239,181,106,0.4);
}
.model-img.glb.dev .glb-cube { color: var(--tone-warning-dot); }
.model-name { font-size: 11px; font-weight: 600; color: var(--ink); }
.model-badge { font-family: var(--font-mono); font-size: 9px; color: var(--ink-faint); }
.card-actions { display: flex; gap: 4px; }
.card-btn { padding: 2px 7px; font-size: 10px; font-weight: 600; color: var(--ink-soft); background: var(--paper-deep); border: 1px solid var(--line); border-radius: var(--radius-chip); cursor: pointer; }
.card-btn.danger { color: var(--tone-danger-dot); }
.card-btn:disabled { opacity: 0.5; cursor: default; }

.model-card.loading, .model-card.empty { cursor: default; font-size: 11px; color: var(--ink-faint); }
.loading-dot { width: 12px; height: 12px; border: 2px solid var(--line-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.mini-err, .mini-msg { font-size: 10px; color: var(--tone-danger-dot); }
.mini-msg { color: var(--ink-soft); }
</style>
