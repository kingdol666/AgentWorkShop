<script setup lang="ts">
/**
 * /projects —— Project 列表 + 创建入口(2026-11-07 控制台 ChatGPT 化换皮)。
 * 复用 $http（Bearer cookie + envelope 解包）；未登录时提示回 /workshop。
 *
 * 布局:裸 console 布局下的白色居中列(与其他控制台页同一令牌族 --chat-*)。
 * 数据逻辑零改动,本轮只动模板外壳与样式声部。
 */
import { onMounted, reactive, ref } from 'vue'
import { useUserStore } from '~/stores/workshop/user'

definePageMeta({ layout: 'console' })

// 认证守卫(与项目详情页同语义:未登录回总览)
const userStore = useUserStore()
onMounted(() => {
  if (!userStore.isLoggedIn) navigateTo('/workshop')
})

interface ProjectDto {
  id: string
  name: string
  description: string
  objective: string
  status: string
  mode: string
  ownerUserId: string
  officeChannelId: string | null
  leadAgentId: string | null
  planVersion: number
  createdAt: string
  updatedAt: string
}

const http = useHttp()
const projects = ref<ProjectDto[]>([])
const loading = ref(false)
const error = ref('')
const form = reactive({ name: '', objective: '', description: '', leaderHarness: 'mock' })

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await http.get<{ data: ProjectDto[] }>('/workshop/projects')
    projects.value = res.data ?? []
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : '加载失败（请先登录 /workshop）'
  }
  finally {
    loading.value = false
  }
}

async function create(): Promise<void> {
  if (!form.name.trim() || !form.objective.trim()) return
  loading.value = true
  error.value = ''
  try {
    const res = await http.post<{ data: ProjectDto }>('/workshop/projects', {
      name: form.name.trim(),
      objective: form.objective.trim(),
      description: form.description.trim() || undefined,
      leaderHarness: form.leaderHarness,
    })
    form.name = ''
    form.objective = ''
    form.description = ''
    form.leaderHarness = 'mock'
    await navigateTo(`/projects/${res.data.id}`)
  }
  catch (e) {
    error.value = e instanceof Error ? e.message : '创建失败'
  }
  finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="projects-page">
    <header class="head">
      <div>
        <h1>项目</h1>
        <p class="sub">
          项目总工 + 交付物 + 成果验收；V1 先覆盖项目办公室/派发/成果闭环。
        </p>
      </div>
      <button
        class="btn ghost"
        :disabled="loading"
        @click="load"
      >
        刷新
      </button>
    </header>

    <p
      v-if="error"
      class="error"
    >
      {{ error }}
    </p>

    <section class="create card">
      <h2>新建项目</h2>
      <div class="grid">
        <label>名称<input
          v-model="form.name"
          placeholder="例如：A 线良率提升"
        ></label>
        <label>目标<input
          v-model="form.objective"
          placeholder="例如：良率提升到 98%"
        ></label>
        <label>Leader 引擎<select
          v-model="form.leaderHarness"
        >
          <option value="mock">
            mock（验证用）
          </option>
          <option value="omp">
            omp（真实 LLM）
          </option>
          <option value="opencode">
            opencode（真实 LLM）
          </option>
          <option value="claude">
            claude（真实 LLM）
          </option>
        </select></label>
        <label class="wide">描述<input
          v-model="form.description"
          placeholder="可选：范围、约束、验收口径"
        ></label>
      </div>
      <button
        class="btn"
        :disabled="loading || !form.name.trim() || !form.objective.trim()"
        @click="create"
      >
        创建项目
      </button>
    </section>

    <section
      v-if="projects.length"
      class="list"
    >
      <article
        v-for="p in projects"
        :key="p.id"
        class="card project"
        @click="navigateTo(`/projects/${p.id}`)"
      >
        <div class="row">
          <strong>{{ p.name }}</strong>
          <span
            class="badge"
            :class="p.status"
          >{{ p.status }}</span>
        </div>
        <p class="objective">
          {{ p.objective }}
        </p>
        <div class="meta">
          <span>mode {{ p.mode }}</span>
          <span>plan v{{ p.planVersion }}</span>
          <span>{{ p.officeChannelId ? '办公室已建' : '缺办公室' }}</span>
        </div>
      </article>
    </section>
    <p
      v-else-if="!loading"
      class="empty"
    >
      还没有项目。上方创建一个，或在 /workshop 先确认已登录。
    </p>
  </div>
</template>

<style scoped>
/* ChatGPT 声部(2026-11-07):白画布居中列 + 发丝线卡片 + 黑主钮;令牌 = --chat-* */
.projects-page {
  flex: 1 1 auto;
  width: 100%;
  max-width: 1080px;
  padding: 30px 28px 52px;
  margin: 0 auto;
  overflow-y: auto;
  color: var(--chat-ink);
  background: var(--chat-canvas);
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  padding-bottom: 16px;
  margin-bottom: 20px;
  border-bottom: 1px solid var(--chat-line);
}
h1 { margin: 0 0 6px; font-size: 24px; font-weight: 650; letter-spacing: -0.02em; }
.sub { margin: 0; color: var(--chat-ink-faint); font-size: 13px; }
.card {
  padding: 18px 20px;
  background: var(--chat-surface);
  border: 1px solid var(--chat-line);
  border-radius: 16px;
}
.create { margin-bottom: 18px; }
.create h2 { margin: 0 0 12px; font-size: 15px; font-weight: 650; }
.grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-bottom: 12px; }
.grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--chat-ink-faint);
}
.grid .wide { grid-column: 1 / -1; }
input, select {
  padding: 9px 11px;
  font-size: 13px;
  color: var(--chat-ink);
  background: var(--chat-canvas);
  border: 1px solid var(--chat-line);
  border-radius: 10px;
  transition: border-color var(--transition-fast);
}
input:focus, select:focus { border-color: var(--chat-line-strong); outline: none; }
input::placeholder { color: var(--chat-ink-faint); }
.btn {
  padding: 8px 14px;
  font-size: 13px;
  font-weight: 600;
  /* 反色主钮:前景取画布色(暗色自动翻为黑字白底) */
  color: var(--chat-canvas);
  cursor: pointer;
  background: var(--chat-ink);
  border: 0;
  border-radius: 10px;
  transition: opacity var(--transition-fast);
}
.btn:hover { opacity: 0.88; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.ghost {
  color: var(--chat-ink);
  background: transparent;
  border: 1px solid var(--chat-line);
}
.btn.ghost:hover { opacity: 1; border-color: var(--chat-line-strong); }
.list { display: grid; grid-template-columns: repeat(auto-fill, minmax(318px, 1fr)); gap: 14px; }
.project { cursor: pointer; transition: border-color var(--transition-fast), box-shadow var(--transition-fast); }
.project:hover {
  border-color: var(--chat-line-strong);
  box-shadow: 0 12px 32px rgb(12 10 9 / 7%);
  transform: translateY(-1px);
}
.project { transition: border-color var(--transition-fast), box-shadow var(--transition-base), transform var(--transition-base); }
.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.row strong { font-size: 14px; }
.badge {
  padding: 2px 9px;
  font-size: 11px;
  line-height: 16px;
  color: var(--chat-ink-soft);
  background: color-mix(in srgb, var(--chat-ink) 6%, transparent);
  border-radius: 999px;
}
.badge.active { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.badge.paused { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.badge.draft { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.badge.completed { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.badge.archived { color: var(--chat-ink-faint); background: color-mix(in srgb, var(--chat-ink) 6%, transparent); }
.objective { margin: 10px 0; font-size: 13px; color: var(--chat-ink-soft); }
.meta {
  display: flex;
  gap: 12px;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11px;
  color: var(--chat-ink-faint);
}
.empty { color: var(--chat-ink-faint); }
.error { color: var(--tone-danger-dot); }
@media (max-width: 960px) { .grid { grid-template-columns: 1fr 1fr; } }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
</style>
