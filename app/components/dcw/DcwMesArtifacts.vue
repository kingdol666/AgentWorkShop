<script setup lang="ts">
/**
 * MES 点位产物弹窗 —— dataHook/图像落盘产物的浏览与预览。
 * 列表来自 GET /api/workshop/dcw/mes-artifacts(node_id);图像/SVG 经
 * /mes-artifacts/file 内联预览(csv/json 新窗口打开)。组件自取数,页面零状态。
 */
import { ref, watch } from 'vue'

const props = defineProps<{
  nodeId: string
  nodeName: string
}>()

const open = defineModel<boolean>('open', { required: true })

interface ArtifactItem { name: string, bytes: number, mime: string, mtime: string | null }
const items = ref<ArtifactItem[]>([])
const loading = ref(false)
const error = ref('')
const preview = ref<ArtifactItem | null>(null)

async function refresh(): Promise<void> {
  if (!props.nodeId) return
  loading.value = true
  error.value = ''
  try {
    const r = await $fetch<{ data?: { artifacts?: ArtifactItem[] } }>('/api/workshop/dcw/mes-artifacts', {
      query: { node_id: props.nodeId, limit: 60 },
    })
    items.value = r.data?.artifacts ?? []
  }
  catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  }
  finally {
    loading.value = false
  }
}

watch(open, (v) => {
  if (v) {
    preview.value = null
    void refresh()
  }
})

const fileUrl = (name: string): string => `/api/workshop/dcw/mes-artifacts/file?node_id=${encodeURIComponent(props.nodeId)}&name=${encodeURIComponent(name)}`
const isImage = (a: ArtifactItem): boolean => a.mime.startsWith('image/')
const fmtBytes = (b: number): string => b >= 1024 * 1024 ? `${(b / 1024 / 1024).toFixed(1)}MB` : `${Math.max(1, Math.round(b / 1024))}KB`
</script>

<template>
  <div
    v-if="open"
    class="modal-mask"
    @click.self="open = false"
  >
    <div class="modal mes-artifacts-modal">
      <h3 class="m-title">
        {{ $t('dcwDetail.mesArtifactsTitle') }} · {{ nodeName || nodeId }}
      </h3>

      <div class="art-toolbar">
        <button
          class="mini-btn"
          :disabled="loading"
          @click="refresh()"
        >
          {{ loading ? '···' : $t('dcwDetail.mesArtifactsRefresh') }}
        </button>
        <span
          v-if="error"
          class="test-result bad"
        >✗ {{ error }}</span>
        <span
          v-else
          class="dim"
        >{{ items.length }}</span>
      </div>

      <div class="art-body">
        <p
          v-if="!loading && items.length === 0"
          class="dim"
        >
          {{ $t('dcwDetail.mesArtifactsEmpty') }}
        </p>
        <ul
          v-else
          class="art-list"
        >
          <li
            v-for="a in items"
            :key="a.name"
            :class="{ on: preview?.name === a.name }"
            @click="preview = a"
          >
            <span class="mono">{{ a.name }}</span>
            <small class="dim">{{ fmtBytes(a.bytes) }} · {{ a.mtime?.slice(5, 19).replace('T', ' ') ?? '' }}</small>
          </li>
        </ul>
        <div
          v-if="preview"
          class="art-preview"
        >
          <img
            v-if="isImage(preview)"
            :src="fileUrl(preview.name)"
            :alt="preview.name"
          >
          <span
            v-else
            class="dim"
          >{{ $t('dcwDetail.mesArtifactsBinary') }}</span>
          <a
            class="mini-btn"
            :href="fileUrl(preview.name)"
            target="_blank"
            rel="noopener"
          >{{ $t('dcwDetail.mesArtifactsOpen') }} {{ preview.name }}</a>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 本页行级样式:scoped 内仅放本组件私有布局;通用词法(.mini-btn/.modal-mask/.mono/.dim)在 main.css */
.mes-artifacts-modal { min-width: 560px; max-width: 860px; }
.art-toolbar { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
.art-body { display: flex; gap: 12px; max-height: 60vh; overflow: auto; }
.art-list { list-style: none; margin: 0; padding: 0; min-width: 260px; }
.art-list li { display: flex; justify-content: space-between; gap: 10px; padding: 5px 8px; border-radius: 6px; cursor: pointer; }
.art-list li:hover, .art-list li.on { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.art-preview { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.art-preview img { max-width: 100%; max-height: 46vh; border: 1px solid var(--line-faint, rgba(255,255,255,.1)); border-radius: 6px; background: #0d1b2a; }
.art-preview pre { max-width: 100%; max-height: 40vh; overflow: auto; font-size: 12px; }
</style>
