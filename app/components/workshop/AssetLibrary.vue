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
import ModelPreview3D from './town/ModelPreview3D.vue'

const assets = useCharacterAssets()

/** 侧边模型库:展示所有设备实体模型(含内置模型、设备目录扫描与用户上传)。 */
const deviceModels = computed(() =>
  assets.models.filter(m => m.kind === 'dev'),
)

/** 可 3D 预览的格式(glb/gltf);obj/fbx 保持占位图标 */
const isPreviewable = (name: string): boolean => /\.(glb|gltf)$/i.test(name)

// 拖起:把模型 id 交给 dataTransfer(HTML5 DnD)
function onDragStart(e: DragEvent, id: string): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData('application/x-aw-model', id)
  e.dataTransfer.setData('text/plain', id)
  e.dataTransfer.effectAllowed = 'copy'
}

// ---------- 上传(设备 3D 模型:拖放/选择 → 本地 3D 预览 → 确认上传) ----------
const uploading = ref(false)
const uploadError = ref('')
const uploadFile = ref<File | null>(null)
const dropActive = ref(false)
const onPickFile = (e: Event): void => {
  const input = e.target as HTMLInputElement
  setUploadFile(input.files?.[0] ?? null)
}
const onDropFile = (e: DragEvent): void => {
  dropActive.value = false
  setUploadFile(e.dataTransfer?.files?.[0] ?? null)
}
const setUploadFile = (f: File | null): void => {
  if (f && !/\.(glb|gltf|obj|fbx)$/i.test(f.name)) {
    uploadError.value = '仅支持 .glb/.gltf/.obj/.fbx 模型文件'
    return
  }
  uploadFile.value = f
  uploadError.value = ''
}
const clearUpload = (): void => {
  uploadFile.value = null
}
async function doUpload(): Promise<void> {
  const f = uploadFile.value
  if (!f) {
    uploadError.value = '请先拖入或选择设备模型文件(.glb/.gltf/.obj/.fbx)'
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

    <!-- 上传区(设备 3D 模型:拖放/选择 → 本地 3D 预览 → 确认上传) -->
    <div
      class="upload-box"
      :class="{ drop: dropActive }"
      @dragover.prevent="dropActive = true"
      @dragleave="dropActive = false"
      @drop.prevent="onDropFile"
    >
      <label class="upload-row">
        <input
          type="file"
          accept=".glb,.gltf,.obj,.fbx"
          class="file-input"
          @change="onPickFile"
        >
        <span class="upload-name">
          <span class="i-tabler-plus upload-ico" />
          {{ uploadFile?.name || '拖放或选择模型文件' }}
        </span>
      </label>
      <span
        v-if="dropActive"
        class="drop-hint"
      >
        <span class="i-tabler-download" />
        松开以选择模型
      </span>

      <!-- 上传前本地 3D 预览(glb/gltf 实时渲染真实形状) -->
      <template v-if="uploadFile">
        <ModelPreview3D
          v-if="isPreviewable(uploadFile.name)"
          :local-file="uploadFile"
          :height="92"
        />
        <span
          v-else
          class="upload-file-tag"
        >{{ uploadFile.name }} (暂不支持 3D 预览)</span>
        <div class="upload-actions">
          <button
            class="upload-btn go"
            :disabled="uploading"
            @click="doUpload"
          >
            {{ uploading ? '上传中…' : '确认上传' }}
          </button>
          <button
            class="upload-btn"
            :disabled="uploading"
            @click="clearUpload"
          >
            取消
          </button>
        </div>
      </template>
      <span
        v-else-if="uploading"
        class="mini-err"
      >上传中…</span>
      <span
        v-if="uploadError && !uploadFile"
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
        <!-- GLB/GLTF:实时 3D 模型预览(真实几何形状);其余格式占位图标 -->
        <ModelPreview3D
          v-if="isPreviewable(m.file)"
          :file="m.file"
          :height="76"
        />
        <span
          v-else
          class="model-img glb dev"
        >
          <span
            class="i-tabler-cpu glb-cube"
            aria-hidden="true"
          />
        </span>
        <span class="model-name">{{ m.name }}</span>
        <span class="model-badge">设备 · 拖拽放置</span>
        <div class="card-actions">
          <button
            v-if="m.file.includes('/assets/game/devices/')"
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
        暂无设备模型。上传一个设备模型即可开始。
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
  width: 180px;
  flex: none;
  padding: 12px 12px 13px;
  background: var(--glass-bg);
  backdrop-filter: var(--glass-blur);
  -webkit-backdrop-filter: var(--glass-blur);
  border: 1px solid var(--glass-line);
  border-radius: var(--radius-panel);
  box-shadow: var(--glass-highlight), var(--shadow-float);
}
.lib-head {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 11px;
  letter-spacing: 0.05em;
  color: var(--ink-faint);
}
.head-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
.head-title {
  font-size: 12px;
  font-weight: 650;
  letter-spacing: 0.02em;
  color: var(--ink);
}
.head-hint { margin-left: auto; font-size: 10px; color: var(--ink-faint); white-space: nowrap; }

.upload-box { display: flex; flex-direction: column; gap: 6px; padding: 7px; background: var(--paper-raised); border: 1px solid var(--line); border-radius: var(--radius-panel-sm); }
.upload-row { display: flex; align-items: center; gap: 5px; font-size: 11px; color: var(--ink-soft); cursor: pointer; }
.file-input { display: none; }
.upload-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.upload-btn {
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 600;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-chip);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast), transform var(--transition-fast);
}
.upload-btn:hover:not(:disabled) { border-color: var(--accent); background: var(--paper-tint); }
.upload-btn:active:not(:disabled) { transform: scale(0.98); }
.upload-btn:disabled { opacity: 0.5; cursor: default; }

.lib-grid { display: flex; flex-direction: column; gap: 7px; max-height: 46vh; overflow: hidden auto; padding-right: 1px; }
.model-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 9px 6px 8px;
  cursor: grab;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
  transition: border-color var(--transition-base), transform var(--transition-base), box-shadow var(--transition-base);
}
.model-card:hover { border-color: var(--line-strong); box-shadow: var(--shadow-float); transform: translateY(-1px); }
.model-card:active { cursor: grabbing; }
.model-img { width: 46px; height: 68px; object-fit: contain; image-rendering: pixelated; pointer-events: none; }
.model-img.glb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 52px;
  height: 44px;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm);
}
.model-img.glb.dev {
  background:
    linear-gradient(160deg, color-mix(in srgb, var(--tone-warning-bg) 70%, var(--paper-deep)), var(--paper-deep));
  border-color: color-mix(in srgb, var(--tone-warning-dot) 30%, var(--line));
}
.glb-cube { font-size: 24px; line-height: 1; color: var(--ink-faint); }
.model-img.glb.dev .glb-cube { color: var(--tone-warning-dot); }
.model-name { font-size: 11px; font-weight: 600; color: var(--ink); }
.model-badge { font-family: var(--font-mono); font-size: 9px; color: var(--ink-faint); }
.card-actions { display: flex; gap: 4px; }
.card-btn {
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 600;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
  cursor: pointer;
  transition: border-color var(--transition-fast), color var(--transition-fast);
}
.card-btn:hover:not(:disabled) { border-color: var(--line-strong); color: var(--ink); }
.card-btn.danger { color: var(--tone-danger-dot); }
.card-btn.danger:hover:not(:disabled) { border-color: color-mix(in srgb, var(--tone-danger-dot) 40%, var(--line)); color: var(--tone-danger-dot); }
.card-btn:disabled { opacity: 0.5; cursor: default; }

.model-card.loading, .model-card.empty { cursor: default; font-size: 11px; color: var(--ink-faint); gap: 7px; }
.loading-dot { width: 12px; height: 12px; border: 2px solid var(--line-strong); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.mini-err { color: var(--tone-danger-dot); }
.mini-err, .mini-msg { font-size: 10px; }
.mini-msg { color: var(--ink-soft); }

/* ============================================================
 * 上传体验优化 + GLB 实时预览(工业 HMI 覆盖)
 * ============================================================ */
.upload-box {
  position: relative;
  gap: 7px;
  border: 1px dashed var(--hud-line, #2a3844);
  background: rgba(14, 20, 29, 0.5);
  transition: border-color 0.16s ease, background 0.16s ease;
}
.upload-box.drop {
  border-color: var(--hud-accent, #4fa8ff);
  background: rgba(79, 168, 255, 0.08);
}
.upload-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
}
.upload-name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--hud-dim, #7f919e);
}
.upload-ico {
  color: var(--hud-accent, #4fa8ff);
  font-size: 13px;
}
.drop-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--hud-accent, #4fa8ff);
  padding: 2px 0 4px;
}
.upload-file-tag {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-dim, #7f919e);
  padding: 3px 6px;
  border: 1px solid var(--hud-line, #2a3844);
  border-radius: 2px;
}
.upload-actions {
  display: flex;
  gap: 6px;
  align-items: center;
}
.upload-btn {
  border-radius: 2px;
  font-family: var(--font-mono);
  letter-spacing: 0.06em;
  padding: 5px 10px;
  font-size: 10px;
}
.upload-btn.go {
  color: var(--hud-amber, #f0a04c);
  border-color: rgba(240, 160, 76, 0.55);
  background: rgba(240, 160, 76, 0.08);
}
.upload-btn.go:hover:not(:disabled) {
  background: rgba(240, 160, 76, 0.16);
  border-color: var(--hud-amber, #f0a04c);
}
/* 模型卡:预览贯通整行,内容左对齐 */
.model-card {
  align-items: stretch;
  padding: 6px;
  gap: 4px;
}
.model-card .model-preview-3d {
  margin-bottom: 2px;
}
.model-card .model-name {
  text-align: left;
  padding: 0 2px;
}
.model-card .model-badge {
  text-align: left;
  padding: 0 2px;
}
.model-card .card-actions {
  justify-content: flex-end;
}
</style>
