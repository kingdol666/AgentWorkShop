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

const harnessOptions = [
  { value: 'mock', label: 'mock · 验证用' },
  { value: 'omp', label: 'omp · 真实 LLM' },
  { value: 'opencode', label: 'opencode · 真实 LLM' },
  { value: 'claude', label: 'claude · 真实 LLM' },
]

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档',
}

function statusText(status: string): string {
  return STATUS_LABEL[status] ?? status
}

function statusTone(status: string): string {
  if (status === 'active') return 'green'
  if (status === 'completed') return 'blue'
  if (status === 'paused') return 'amber'
  if (status === 'archived') return 'gray'
  return 'neutral'
}

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
    <header class="aw-page-head">
      <div>
        <p class="aw-kicker">
          Project Router v3 / portfolio
        </p>
        <h1>项目</h1>
        <p class="sub">
          项目总工 + 交付物 + 成果验收；项目办公室由同一个 Project Leader 持续接收补充需求。
        </p>
      </div>
      <button
        class="btn ghost"
        :disabled="loading"
        @click="load"
      >
        <span
          class="i-tabler-refresh"
          :class="{ spin: loading }"
          aria-hidden="true"
        />
        刷新
      </button>
    </header>

    <p
      v-if="error"
      class="notice danger"
    >
      {{ error }}
    </p>

    <section class="card create">
      <div class="card-head">
        <div>
          <h2>新建项目</h2>
          <p class="card-sub">
            创建后自动生成项目办公室与 Project Leader；先绑定 Channel、建交付物，再激活。
          </p>
        </div>
      </div>
      <div class="form-grid">
        <label class="field">
          <span>项目名称</span>
          <input
            v-model="form.name"
            placeholder="例如：A 线良率提升"
          >
        </label>
        <label class="field">
          <span>项目目标</span>
          <input
            v-model="form.objective"
            placeholder="例如：良率提升到 98%"
          >
        </label>
        <label class="field wide">
          <span>描述（可选）</span>
          <input
            v-model="form.description"
            placeholder="补充背景、边界或交付偏好"
          >
        </label>
        <label class="field">
          <span>Leader 引擎</span>
          <a-select
            v-model:value="form.leaderHarness"
            class="field-select"
            :options="harnessOptions"
          />
        </label>
      </div>
      <div class="create-actions">
        <span class="muted">创建后进入项目页继续配置；不会立刻派发任务。</span>
        <button
          class="btn primary"
          :disabled="loading || !form.name.trim() || !form.objective.trim()"
          @click="create"
        >
          <span
            class="i-tabler-plus"
            aria-hidden="true"
          />
          创建项目
        </button>
      </div>
    </section>

    <section
      v-if="projects.length"
      class="project-grid"
    >
      <article
        v-for="p in projects"
        :key="p.id"
        class="card project"
        role="link"
        tabindex="0"
        @click="navigateTo(`/projects/${p.id}`)"
        @keydown.enter="navigateTo(`/projects/${p.id}`)"
      >
        <div class="project-top">
          <h2>{{ p.name }}</h2>
          <span
            class="status-pill"
            :class="statusTone(p.status)"
          >{{ statusText(p.status) }}</span>
        </div>
        <p class="objective">
          {{ p.objective }}
        </p>
        <div class="meta">
          <span class="meta-chip mono">mode {{ p.mode }}</span>
          <span class="meta-chip mono">plan v{{ p.planVersion }}</span>
          <span class="meta-chip">
            <span
              class="i-tabler-building-community"
              aria-hidden="true"
            />
            {{ p.officeChannelId ? '办公室已建' : '缺办公室' }}
          </span>
        </div>
        <span class="project-open">
          打开项目
          <span
            class="i-tabler-arrow-right"
            aria-hidden="true"
          />
        </span>
      </article>
    </section>
    <div
      v-else-if="!loading"
      class="empty card"
    >
      <span
        class="i-tabler-folders"
        aria-hidden="true"
      />
      <strong>还没有项目</strong>
      <p>在上方创建一个，或先在 /workshop 确认已登录。</p>
    </div>
  </div>
</template>

<style scoped>
.projects-page {
  width: 100%;
  max-width: 1160px;
  margin: 0 auto;
  padding: 4px 8px 48px;
  color: var(--ink);
}

.sub {
  max-width: 76ch;
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--ink-soft);
}

.card {
  padding: 18px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-lift-1);
}

.create {
  margin-bottom: 18px;
}

.card-head {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 14px;
}

.card-head h2 {
  margin: 0;
  font-size: 15.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink);
}

.card-sub {
  max-width: 70ch;
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-faint);
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  font-size: 11.5px;
  color: var(--ink-faint);
}

.field.wide {
  grid-column: 1 / -1;
}

input {
  min-height: 36px;
  padding: 8px 10px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--ink);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-control);
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast);
}

input::placeholder {
  color: var(--ink-fainter);
}

input:hover {
  border-color: var(--line-strong);
}

input:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.field-select {
  width: 100%;
}

.form-grid :deep(.ant-select-selector) {
  min-height: 36px;
  background: var(--paper-deep) !important;
  border-color: var(--line) !important;
}

.create-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
  margin-top: 14px;
}

.muted {
  font-size: 12px;
  color: var(--ink-faint);
}

.mono {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

.btn {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  justify-content: center;
  padding: 7px 14px;
  font-family: var(--font-body);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.2;
  color: var(--ink);
  white-space: nowrap;
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.btn:hover:not(:disabled) {
  background: var(--hover-tint);
  border-color: var(--ink-fainter);
}

.btn:active:not(:disabled) {
  transform: scale(0.97);
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.btn.primary {
  font-weight: 600;
  color: var(--on-accent);
  background: var(--accent);
  border-color: var(--accent);
}

.btn.primary:hover:not(:disabled) {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
}

.btn.ghost {
  color: var(--ink-soft);
  background: transparent;
}

.spin {
  animation: spin 900ms linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.notice {
  display: flex;
  gap: 7px;
  align-items: flex-start;
  padding: 9px 12px;
  margin: 0 0 14px;
  font-size: 12.5px;
  line-height: 1.55;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
}

.notice.danger {
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
  border-color: color-mix(in srgb, var(--tone-danger-dot) 20%, transparent);
}

.project-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
}

.project {
  display: flex;
  flex-direction: column;
  gap: 10px;
  cursor: pointer;
  transition:
    border-color var(--transition-fast),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1),
    box-shadow var(--transition-fast);
}

.project:hover {
  border-color: var(--line-strong);
  box-shadow: var(--shadow-lift-2);
  transform: translateY(-2px);
}

.project:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
}

.project-top {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: flex-start;
  justify-content: space-between;
}

.project h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--ink);
}

.status-pill {
  --pill-bg: var(--tone-neutral-bg);
  --pill-fg: var(--tone-neutral-dot);

  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 600;
  line-height: 1.2;
  color: var(--pill-fg);
  white-space: nowrap;
  background: var(--pill-bg);
  border: 1px solid color-mix(in srgb, var(--pill-fg) 22%, transparent);
  border-radius: var(--radius-pill);
}

.status-pill::before {
  width: 6px;
  height: 6px;
  content: '';
  background: currentcolor;
  border-radius: 50%;
}

.status-pill.green {
  --pill-bg: var(--tone-success-bg);
  --pill-fg: var(--tone-success-dot);
}

.status-pill.blue {
  --pill-bg: var(--tone-info-bg);
  --pill-fg: var(--tone-info-dot);
}

.status-pill.amber {
  --pill-bg: var(--tone-warning-bg);
  --pill-fg: var(--tone-warning-dot);
}

.status-pill.gray {
  --pill-bg: var(--tone-neutral-bg);
  --pill-fg: var(--tone-neutral-dot);
}

.objective {
  display: -webkit-box;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--ink-soft);
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: auto;
}

.meta-chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 3px 7px;
  font-size: 10.5px;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}

.project-open {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  font-size: 11.5px;
  color: var(--accent);
}

.empty {
  display: flex;
  flex-direction: column;
  gap: 5px;
  align-items: center;
  justify-content: center;
  padding: 48px 18px;
  text-align: center;
}

.empty .i-tabler-folders {
  margin-bottom: 4px;
  font-size: 26px;
  color: var(--ink-fainter);
}

.empty strong {
  font-size: 14px;
  color: var(--ink-soft);
}

.empty p {
  margin: 0;
  font-size: 12px;
  color: var(--ink-faint);
}

@media (max-width: 900px) {
  .projects-page {
    padding: 0 2px 40px;
  }

  .aw-page-head > .btn {
    align-self: flex-start;
  }

  .form-grid {
    grid-template-columns: 1fr;
  }

  .field.wide {
    grid-column: auto;
  }

  .create-actions {
    flex-direction: column;
    align-items: stretch;
  }

  .create-actions .btn {
    width: 100%;
    min-height: 40px;
  }

  .project-grid {
    grid-template-columns: 1fr;
  }
}

@media (pointer: coarse) {
  .btn {
    min-height: 40px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .project {
    transition: none;
  }

  .spin {
    animation: none;
  }
}
</style>
