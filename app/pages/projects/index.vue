<script setup lang="ts">
/**
 * /projects —— Project 列表 + 创建入口。
 * 复用 $http（Bearer cookie + envelope 解包）；未登录时提示回 /workshop。
 */
import { onMounted, reactive, ref } from 'vue'

definePageMeta({ layout: 'default' })

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
        <label class="wide">描述<input
          v-model="form.description"
          placeholder="可选"
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
.projects-page { max-width: 1080px; margin: 0 auto; padding: 24px; color: #e6e8ee; }
.head { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 20px; }
h1 { margin: 0 0 6px; font-size: 24px; }
.sub { margin: 0; color: #9aa4b2; font-size: 13px; }
.card { background: #161a22; border: 1px solid #2a3140; border-radius: 10px; padding: 16px; }
.create { margin-bottom: 18px; }
.create h2 { margin: 0 0 12px; font-size: 16px; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
.grid label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #9aa4b2; }
.grid .wide { grid-column: 1 / -1; }
input { background: #0f131a; border: 1px solid #2a3140; border-radius: 6px; color: #e6e8ee; padding: 8px 10px; }
.btn { background: #3b82f6; color: white; border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.btn.ghost { background: transparent; border: 1px solid #2a3140; color: #cbd5e1; }
.list { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; }
.project { cursor: pointer; }
.project:hover { border-color: #3b82f6; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.badge { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #263042; color: #cbd5e1; }
.badge.active { background: #14351f; color: #86efac; }
.badge.paused { background: #3a2c12; color: #fcd34d; }
.badge.completed { background: #1e2a4a; color: #93c5fd; }
.badge.archived { background: #2a2f3a; color: #9aa4b2; }
.objective { color: #cbd5e1; font-size: 13px; margin: 10px 0; }
.meta { display: flex; gap: 12px; color: #7c8798; font-size: 11px; }
.empty { color: #9aa4b2; }
.error { color: #fca5a5; }
@media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
</style>
