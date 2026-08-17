<script setup lang="ts">
/**
 * FileSelector:服务器目录选择弹窗(FileSelector 数据源 = GET /api/workshop/fs/dirs)。
 * 面包屑导航 + 目录列表(点击进入 / 📂 图标指示有子目录);支持地址栏直接输入绝对路径跳转。
 * 确定 -> emit('select', 绝对路径);浏览器自身无法读服务器路径,故走后端目录浏览。
 */
import { message } from 'ant-design-vue'
import { useUserStore } from '../../stores/workshop/user'

const props = defineProps<{
  /** 受控 open(v-model:open) */
  open: boolean
  /** 初始浏览路径(空 = 项目根) */
  initialPath?: string
  title?: string
}>()
const emit = defineEmits<{
  (e: 'update:open', v: boolean): void
  (e: 'select', path: string): void
}>()

const userStore = useUserStore()
const cwd = ref('')
const parent = ref<string | null>(null)
const dirs = ref<Array<{ name: string, path: string, hasChildren: boolean }>>([])
const loading = ref(false)
/** 地址栏(手动输入绝对路径跳转) */
const manualPath = ref('')

const load = async (path?: string): Promise<void> => {
  loading.value = true
  try {
    const res = await fetch(`/api/workshop/fs/dirs${path ? `?path=${encodeURIComponent(path)}` : ''}`, {
      headers: { authorization: `Bearer ${userStore.token}` },
    })
    const json = await res.json()
    if (json.code !== 0) {
      message.warning(json.message ?? '目录读取失败')
      return
    }
    cwd.value = json.data.cwd
    parent.value = json.data.parent
    dirs.value = json.data.dirs ?? []
    manualPath.value = json.data.cwd
  }
  finally {
    loading.value = false
  }
}

watch(() => props.open, (v) => {
  if (v) void load(props.initialPath || cwd.value || undefined)
})

/** 面包屑:把 cwd 按分隔符拆段,逐级可点 */
const crumbs = computed(() => {
  const sep = cwd.value.includes('\\') ? '\\' : '/'
  const parts = cwd.value.split(sep).filter(Boolean)
  const out: Array<{ label: string, path: string }> = []
  // Windows 盘符("D:")从根拼;POSIX 首段带根斜杠
  let acc = ''
  for (const p of parts) {
    acc = acc ? acc + sep + p : (p.endsWith(':') ? p + sep : sep + p)
    out.push({ label: p, path: acc })
  }
  return out
})

const enter = (path: string): void => void load(path)
const goManual = (): void => {
  const p = manualPath.value.trim()
  if (p) void load(p)
}
const confirm = (): void => {
  if (!cwd.value) return
  emit('select', cwd.value)
  emit('update:open', false)
}
const cancel = (): void => emit('update:open', false)
</script>

<template>
  <a-modal
    :open="open"
    :title="title ?? '选择工作目录'"
    :width="640"
    ok-text="选择此目录"
    cancel-text="取消"
    :confirm-loading="loading"
    @ok="confirm"
    @cancel="cancel"
  >
    <div class="fs">
      <!-- 地址栏:面包屑 + 手动输入跳转 -->
      <div class="addr">
        <a-breadcrumb class="crumbs">
          <a-breadcrumb-item
            v-for="(c, i) in crumbs"
            :key="c.path + i"
          >
            <a @click.prevent="enter(c.path)">{{ c.label }}</a>
          </a-breadcrumb-item>
        </a-breadcrumb>
      </div>
      <a-input-search
        v-model:value="manualPath"
        size="small"
        class="manual"
        placeholder="输入绝对路径跳转(如 D:\\projects\\my-app)"
        enter-button="跳转"
        @search="goManual"
      />

      <!-- 目录列表 -->
      <a-spin :spinning="loading">
        <div class="list">
          <div
            v-if="parent"
            class="row up"
            @click="enter(parent)"
          >
            <span class="icon">⬆</span>
            <span class="name">..(上一级)</span>
          </div>
          <div
            v-for="d in dirs"
            :key="d.path"
            class="row"
            @click="enter(d.path)"
            @dblclick="confirm"
          >
            <span class="icon">{{ d.hasChildren ? '📂' : '📁' }}</span>
            <span class="name">{{ d.name }}</span>
          </div>
          <div
            v-if="!loading && dirs.length === 0"
            class="empty"
          >
            (无子目录;可直接「选择此目录」使用当前位置)
          </div>
        </div>
      </a-spin>

      <div class="hint">
        双击目录 = 直接选用;选定路径将作为团队工作目录(Agent 作业 cwd),不存在时会自动创建。
      </div>
    </div>
  </a-modal>
</template>

<style scoped>
.fs { display: flex; flex-direction: column; gap: 8px; }
.addr {
  padding: 4px 8px;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
  background: color-mix(in srgb, currentColor 5%, transparent);
  border-radius: 4px;
}
.crumbs :deep(a) { color: var(--color-primary); }
.manual { max-width: 100%; }
.list {
  height: 280px;
  overflow-y: auto;
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 6px;
}
.row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}
.row:hover { background: color-mix(in srgb, currentColor 8%, transparent); }
.row.up { opacity: 0.7; }
.icon { flex: 0 0 auto; }
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.empty { padding: 24px; font-size: 12px; opacity: 0.4; text-align: center; }
.hint { font-size: 11px; opacity: 0.55; }
</style>
