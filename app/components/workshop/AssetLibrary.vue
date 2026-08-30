<script setup lang="ts">
/**
 * 设备模型库(Asset Library)面板 —— 只列举「设备/实体」3D 模型,支持上传/删除。
 *
 * 交互:
 *  - 仅展示 kind === 'dev' 的模型(扫描 public/assets/game/devices + 用户上传);
 *    character 角色模型不出现在模型库 —— 在频道成员管理中为成员设置。
 *  - 每张模型卡可拖拽:拖起把 assetId 写入 dataTransfer,落到孪生场景 →
 *    TownScene3D.dropModelOnWorld() 在落点生成一个设备实例(数字孪生)。
 *  - 上传:选择 .glb/.gltf/.obj/.fbx → POST /api/workshop/assets/devices,写入 devices 目录。
 *  - 删除:删除对应模型文件(仅限 devices 目录内)。
 */
import { useCharacterAssets } from '@/app/composables/workshop/useCharacterAssets'
import ModelPreview3D from './town/ModelPreview3D.vue'

const { t } = useI18n()

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
    uploadError.value = t('assetLibrary.kcjqcaw012')
    return
  }
  uploading.value = true
  uploadError.value = ''
  try {
    const model = await assets.uploadDevice(f)
    uploadFile.value = null
    uploadError.value = t('assetLibrary.k8nv3or016', { p0: model.name })
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
    deleteMsg.value = t('assetLibrary.k8n918k013')
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
      <span class="head-title">{{ $t('assetLibrary.k7la4x5001') }}</span>
      <span class="head-hint">{{ $t('assetLibrary.kulif5b002') }}</span>
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
          {{ uploadFile?.name || $t('assetLibrary.k1iiort6010') }}
        </span>
      </label>
      <span
        v-if="dropActive"
        class="drop-hint"
      >
        <span class="i-tabler-download" />
        {{ $t('assetLibrary.k5hg6jq003') }}
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
        >{{ uploadFile.name }} ({{ $t('assetLibrary.k1xz5wvk009') }}</span>
        <div class="upload-actions">
          <button
            class="upload-btn go"
            :disabled="uploading"
            @click="doUpload"
          >
            {{ uploading ? $t('assetLibrary.k1ar7n8i005') : $t('assetLibrary.k1hhga4h014') }}
          </button>
          <button
            class="upload-btn"
            :disabled="uploading"
            @click="clearUpload"
          >
            {{ $t('assetLibrary.k3xdnn004') }}
          </button>
        </div>
      </template>
      <span
        v-else-if="uploading"
        class="mini-err"
      >{{ $t('assetLibrary.k1ar7n8i005') }}</span>
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
        :title="m.hint || $t('assetLibrary.katn7lo015', { p0: m.name })"
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
        <span class="model-badge">{{ $t('assetLibrary.k1n32zs0006') }}</span>
        <div class="card-actions">
          <button
            v-if="m.file.includes('/assets/game/devices/')"
            class="card-btn danger"
            :disabled="deletingId === m.id"
            @click="doRemove(m.id)"
          >
            {{ deletingId === m.id ? '…' : $t('assetLibrary.k498l011') }}
          </button>
        </div>
      </div>
      <div
        v-if="!assets.loaded"
        class="lib-note"
      >
        <span class="loading-dot" />
        {{ $t('assetLibrary.k1kq2tmi007') }}
      </div>
      <div
        v-else-if="deviceModels.length === 0"
        class="lib-note"
      >
        {{ $t('assetLibrary.k15527e1008') }}
      </div>
    </div>

    <span
      v-if="deleteMsg"
      class="mini-msg"
    >{{ deleteMsg }}</span>
  </aside>
</template>

<style scoped>
/* ============================================================
 * 设备模型库 —— 工业 HMI 单层样式(消费 .town-view 的 --hud-* 令牌,
 * 带本地兜底;不再依赖宿主 :deep 覆盖)
 * ============================================================ */
.asset-lib {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 184px;
  flex: none;
  padding: 0 0 10px;
  font-family: var(--font-body);
}
.lib-head {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 10px 12px 6px;
  border-bottom: 1px solid rgba(38, 51, 64, 0.45);
}
.head-title {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.16em;
  color: var(--hud-text, #d9e4ee);
  white-space: nowrap;
}
.head-hint {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 8.5px;
  color: var(--hud-faint, #5b6c7b);
  white-space: nowrap;
}

/* 上传区:虚线收件格(拖放/选择 → 本地 3D 预览 → 确认) */
.upload-box {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin: 8px 10px 0;
  padding: 7px;
  border: 1px dashed rgba(38, 51, 64, 0.8);
  border-radius: 2px;
  background: rgba(11, 16, 24, 0.4);
  transition: border-color 0.16s var(--hud-ease, ease), background 0.16s var(--hud-ease, ease);
}
.upload-box.drop {
  border-color: var(--hud-accent, #4da3ff);
  background: rgba(77, 163, 255, 0.08);
}
.upload-row { display: flex; align-items: center; gap: 6px; min-height: 26px; cursor: pointer; }
.file-input { display: none; }
.upload-name {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--hud-dim, #8496a5);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.upload-ico { color: var(--hud-accent, #4da3ff); font-size: 13px; }
.drop-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--hud-accent, #4da3ff);
  padding: 2px 0 4px;
}
.upload-file-tag {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-dim, #8496a5);
  padding: 3px 6px;
  border: 1px solid var(--hud-line, #263340);
  border-radius: 2px;
}
.upload-actions { display: flex; gap: 6px; align-items: center; }
.upload-btn {
  padding: 5px 10px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--hud-text, #d9e4ee);
  background: var(--hud-panel-raised, #141b26);
  border: 1px solid var(--hud-line, #263340);
  border-radius: 2px;
  cursor: pointer;
  transition: border-color 0.14s var(--hud-ease, ease), color 0.14s var(--hud-ease, ease);
}
.upload-btn:hover:not(:disabled) { border-color: var(--hud-accent, #4da3ff); color: var(--hud-accent, #4da3ff); }
.upload-btn:disabled { opacity: 0.45; cursor: default; }
.upload-btn.go {
  color: var(--hud-amber, #f5a742);
  border-color: rgba(245, 167, 66, 0.55);
  background: rgba(245, 167, 66, 0.08);
}
.upload-btn.go:hover:not(:disabled) {
  background: rgba(245, 167, 66, 0.16);
  border-color: var(--hud-amber, #f5a742);
  color: var(--hud-amber, #f5a742);
}
.mini-err { font-family: var(--font-mono); font-size: 9.5px; color: var(--hud-danger, #ff6b5c); }
.mini-err, .mini-msg { font-size: 10px; }
.mini-msg { font-family: var(--font-mono); color: var(--hud-dim, #8496a5); padding: 0 10px; }

/* 模型清单:方角装备行 */
.lib-grid {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 42vh;
  overflow: hidden auto;
  padding: 6px 10px 2px;
}
.model-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 4px;
  padding: 6px;
  cursor: grab;
  background: rgba(20, 27, 38, 0.65);
  border: 0;
  border-radius: 2px;
  transition: background 0.14s var(--hud-ease, ease);
}
.model-card:hover {
  background: var(--hud-panel-hover, #1a2432);
}
.model-card:active { cursor: grabbing; }
.model-card .model-preview-3d { margin-bottom: 2px; }
.model-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--hud-text, #d9e4ee);
  text-align: left;
  padding: 0 2px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-badge {
  font-family: var(--font-mono);
  font-size: 8.5px;
  letter-spacing: 0.08em;
  color: var(--hud-faint, #5b6c7b);
  text-align: left;
  padding: 0 2px;
}
.card-actions { display: flex; justify-content: flex-end; gap: 4px; }
.card-btn {
  padding: 2px 8px;
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--hud-text, #d9e4ee);
  background: transparent;
  border: 1px solid var(--hud-line, #263340);
  border-radius: 2px;
  cursor: pointer;
  transition: border-color 0.14s var(--hud-ease, ease), color 0.14s var(--hud-ease, ease);
}
.card-btn:hover:not(:disabled) { border-color: var(--hud-accent, #4da3ff); color: var(--hud-accent, #4da3ff); }
.card-btn.danger { color: var(--hud-danger, #ff6b5c); }
.card-btn.danger:hover:not(:disabled) { border-color: var(--hud-danger, #ff6b5c); color: var(--hud-danger, #ff6b5c); }
.card-btn:disabled { opacity: 0.45; cursor: default; }

/* 非 GLB 格式占位图标(obj/fbx 暂不支持实时预览) */
.model-img {
  width: 46px;
  height: 68px;
  object-fit: contain;
  pointer-events: none;
}
.model-img.glb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 44px;
  background: var(--hud-input, #0b1018);
  border: 1px dashed var(--hud-line, #263340);
  border-radius: 2px;
}
.glb-cube { font-size: 24px; line-height: 1; color: var(--hud-faint, #5b6c7b); }

.lib-note {
  display: flex;
  gap: 7px;
  align-items: center;
  padding: 8px 2px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-faint, #5b6c7b);
}
.loading-dot {
  width: 12px;
  height: 12px;
  border: 2px solid var(--hud-line, #263340);
  border-top-color: var(--hud-accent, #4da3ff);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .loading-dot { animation: none; } }
</style>
