<script setup lang="ts">
/**
 * 设备模型库(Asset Library)面板 —— 只列举「设备/实体」3D 模型,支持上传/删除。
 *
 * 交互:
 *  - 仅展示 kind === 'dev' 的模型(扫描 public/assets/game/devices + 用户上传);
 *    character 角色模型不出现在模型库 —— 在频道成员管理中为成员设置。
 *  - 每张模型卡可拖拽:拖起把 assetId 写入 dataTransfer,落到小镇场景 →
 *    TownScene3D.dropModelOnWorld() 在落点生成一个设备实例(数字孪生)。
 *  - 上传:选择 .glb/.gltf/.obj/.fbx → POST /api/workshop/assets/devices,写入 devices 目录。
 *  - 删除:删除对应模型文件(仅限 devices 目录内)。
 */
import { useCharacterAssets } from '@/app/composables/workshop/useCharacterAssets'

const assets = useCharacterAssets()

/** 侧边模型库:仅设备目录(public/assets/game/devices)下的设备模型。
 *  内置 device-3d 等位于 character 目录的模型不出现;角色模型在频道成员管理中设置。 */
const deviceModels = computed(() =>
  assets.models.filter(m => m.kind === 'dev' && m.file.includes('/assets/game/devices/')),
)

// 拖起:把模型 id 交给 dataTransfer(HTML5 DnD)
function onDragStart(e: DragEvent, id: string): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-aw-model', id)
  e.dataTransfer.setData('text/plain', id)
  e.dataTransfer.effectAllowed = 'copy'
}

// ---------- 上传(设备 3D 模型) ----------
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
    uploadError.value = '请先选择设备模型文件(.glb/.gltf/.obj/.fbx)'
    return
  }
  uploading.value = true
  uploadError.value = ''
  try {
    const model = await assets.uploadDevice(f)
    uploadFile.value = null
    uploadError.value = `已上传 → ${model.name}`
  }
  catch (err) {
    uploadError.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    uploading.value = false
  }
}

// ---------- 删除(设备模型文件;已生成实例不受影响,刷新后节点因缺模型被跳过) ----------
const deletingId = ref('')
const deleteMsg = ref('')
async function doRemove(id: string): Promise<void> {
  deletingId.value = id
  deleteMsg.value = ''
  try {
    await assets.removeDevice(id)
    deleteMsg.value = '已删除模型文件'
  }
  catch (err) {
    deleteMsg.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    deletingId.value = ''
  }
}
</script>

<template>
  <aside class="asset-lib">
    <div class="lib-head">
      <span class="head-dot" />
      <span class="head-title">设备模型库</span>
      <span class="head-hint">拖入小镇生成实例</span>
    </div>

    <!-- 上传区(设备 3D 模型) -->
    <div class="upload-box">
      <label class="upload-row">
        <input
          type="file"
          accept=".glb,.gltf,.obj,.fbx"
          class="file-input"
          @change="onPickFile"
        >
        <span class="upload-name">{{ uploadFile?.name || '选择模型(glb/gltf/obj/fbx)' }}</span>
      </label>
      <button
        class="upload-btn"
        :disabled="uploading"
        @click="doUpload"
      >
        {{ uploading ? '上传中…' : '上传设备模型' }}
      </button>
      <span
        v-if="uploadError"
        class="mini-err"
      >{{ uploadError }}</span>
    </div>

    <div class="lib-grid">
      <div
        v-for="m in deviceModels"
        :key="m.id"
        class="model-card"
        :data-model-id="m.id"
        draggable="true"
        :title="m.hint || `拖到小镇场景即生成设备实例 · ${m.name}`"
        @dragstart="onDragStart($event, m.id)"
      >
        <span
          class="model-img glb dev"
        >
          <span class="glb-cube">⚙</span>
        </span>
        <span class="model-name">{{ m.name }}</span>
        <span class="model-badge">设备 · 拖拽放置</span>
        <div class="card-actions">
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
        载入设备模型库…
      </div>
      <div
        v-else-if="deviceModels.length === 0"
        class="model-card empty"
      >
        暂无设备模型。把 .glb 放进 public/assets/game/devices 或上传。
      </div>
    </div>

    <span
      v-if="deleteMsg"
      class="mini-msg"
    >{{ deleteMsg }}</span>
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
