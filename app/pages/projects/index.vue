<script setup lang="ts">
/**
 * /projects —— 项目中心（Project 层前端入口）。
 *
 * 信息架构：目标 → 计划 → 派发 → 交付 → 验收。列表一屏回答"每个项目走到哪了"：
 *  - 顶部统计带：全部 / 进行中 / 待审批 / 已完成（全量口径，不受筛选影响）
 *  - 工具行：搜索（名称/目标/描述）+ 状态分段筛选 + 刷新
 *  - 项目卡：状态、目标、工作项进度、频道/交付物/审批摘要、最近活动
 *  数据来自 GET /workshop/projects（2026-11-09 起服务端附带 summary，前端零 N+1）。
 *
 * 创建有两条真实通道：
 *  1) 空白项目：POST /workshop/projects（必须显式选择 Leader 引擎）
 *  2) 蓝图实例化：POST /workshop/projects/instantiate（建频道→绑定→建计划→（免批则）激活）
 * 两条通道都落到详情页，由同一个 Project Leader 续写计划。
 */
import { useUserStore } from '~/stores/workshop/user'

definePageMeta({ layout: 'default' })

const { t } = useI18n()
useHead({ title: () => `${t('menu.projects')} · AgentWorkShop` })

const http = useHttp()
const userStore = useUserStore()

interface ProjectSummary {
  workItems: number
  completedWorkItems: number
  progress: number
  deliverables: number
  requiredDeliverables: number
  approvedDeliverables: number
  acceptanceProgress: number
  channels: number
  members: number
  pendingApprovals: number
  lastActivityAt: string
}

interface ProjectDto {
  id: string
  name: string
  description: string
  objective: string
  status: string
  mode: string
  routingPolicy: string
  ownerUserId: string
  officeChannelId: string | null
  leadAgentId: string | null
  planVersion: number
  createdAt: string
  updatedAt: string
  summary: ProjectSummary
}

interface HarnessMeta {
  id: string
  label: string
  description: string
  available: boolean
  inprocess: boolean
  error?: string | null
}

interface BlueprintDto {
  id: string
  name: string
  objective: string
  channels: string[]
  routingPolicy: string
  planApprovalRequired: boolean
}

const projects = ref<ProjectDto[]>([])
const blueprints = ref<BlueprintDto[]>([])
const harnesses = ref<HarnessMeta[]>([])
const loading = ref(false)
const error = ref('')
const keyword = ref('')
const statusFilter = ref<'all' | 'active' | 'draft' | 'completed' | 'archived'>('all')

const createOpen = ref(false)
const creating = ref(false)
const createError = ref('')
const form = reactive({
  name: '',
  objective: '',
  description: '',
  leaderHarness: '',
  routingPolicy: 'technical' as 'technical' | 'legacy',
  autoDispatch: false,
})
const blueprintPick = ref('')
const instantiating = ref(false)

const errMsg = (e: unknown): string =>
  (e as { response?: { data?: { message?: string } } })?.response?.data?.message
  ?? (e instanceof Error ? e.message : '请求失败')

/* ── 数据 ─────────────────────────────────────────────────────────────── */

async function load(): Promise<void> {
  loading.value = true
  error.value = ''
  try {
    const res = await http.get<{ data: ProjectDto[] }>('/workshop/projects')
    projects.value = res.data ?? []
  }
  catch (e) {
    error.value = errMsg(e)
  }
  finally {
    loading.value = false
  }
}

/** 引擎清单（可用性探测）+ 蓝图清单（可失败：不阻塞列表）。 */
async function loadCreateSources(): Promise<void> {
  const [h, b] = await Promise.allSettled([
    http.get<{ data: { harnesses: HarnessMeta[] } }>('/workshop/harnesses'),
    http.get<{ data: BlueprintDto[] }>('/workshop/project-blueprints'),
  ])
  if (h.status === 'fulfilled') {
    harnesses.value = h.value.data?.harnesses ?? []
    if (!form.leaderHarness) {
      const firstReal = harnesses.value.find(x => x.available && x.id !== 'mock')
      form.leaderHarness = firstReal?.id ?? harnesses.value.find(x => x.available)?.id ?? 'mock'
    }
  }
  if (b.status === 'fulfilled') blueprints.value = b.value.data ?? []
}

/* ── 派生 ─────────────────────────────────────────────────────────────── */

const statusLabel = (s: string): string => ({
  draft: '草稿',
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  archived: '已归档',
}[s] ?? s)

const stats = computed(() => {
  const total = projects.value.length
  return {
    total,
    active: projects.value.filter(p => p.status === 'active').length,
    pending: projects.value.reduce((n, p) => n + (p.summary?.pendingApprovals ?? 0), 0),
    completed: projects.value.filter(p => p.status === 'completed').length,
    workItems: projects.value.reduce((n, p) => n + (p.summary?.workItems ?? 0), 0),
  }
})

const filters = computed(() => ([
  { key: 'all', label: '全部', n: projects.value.length },
  { key: 'active', label: '进行中', n: projects.value.filter(p => p.status === 'active').length },
  { key: 'draft', label: '草稿', n: projects.value.filter(p => p.status === 'draft').length },
  { key: 'completed', label: '已完成', n: projects.value.filter(p => p.status === 'completed').length },
] as const))

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  return projects.value.filter((p) => {
    if (statusFilter.value !== 'all' && p.status !== statusFilter.value) return false
    if (!q) return true
    return `${p.name} ${p.objective} ${p.description}`.toLowerCase().includes(q)
  })
})

const pct = (v: number | undefined): number => Math.round(Number(v ?? 0) * 100)

function relTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const min = Math.floor(ms / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} 小时前`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d} 天前`
  return new Date(iso).toLocaleDateString()
}

const availableHarnesses = computed(() => harnesses.value.filter(h => h.available))

/* ── 动作 ─────────────────────────────────────────────────────────────── */

onMounted(() => {
  if (!userStore.isLoggedIn) {
    navigateTo('/workshop')
    return
  }
  void load()
  void loadCreateSources()
})

function openCreate(): void {
  createError.value = ''
  createOpen.value = true
  if (!harnesses.value.length) void loadCreateSources()
}

async function create(): Promise<void> {
  if (!form.name.trim() || !form.objective.trim() || !form.leaderHarness) return
  creating.value = true
  createError.value = ''
  try {
    const res = await http.post<{ data: ProjectDto }>('/workshop/projects', {
      name: form.name.trim(),
      objective: form.objective.trim(),
      description: form.description.trim() || undefined,
      leaderHarness: form.leaderHarness,
      routingPolicy: form.routingPolicy,
      autoDispatch: form.autoDispatch,
    })
    createOpen.value = false
    await navigateTo(`/projects/${res.data.id}`)
  }
  catch (e) {
    createError.value = errMsg(e)
  }
  finally {
    creating.value = false
  }
}

async function instantiate(): Promise<void> {
  if (!blueprintPick.value) return
  instantiating.value = true
  createError.value = ''
  try {
    const res = await http.post<{ data: { projectId: string, status: string } }>('/workshop/projects/instantiate', {
      template: blueprintPick.value,
    })
    createOpen.value = false
    await navigateTo(`/projects/${res.data.projectId}`)
  }
  catch (e) {
    createError.value = errMsg(e)
  }
  finally {
    instantiating.value = false
  }
}
</script>

<template>
  <div class="projects-page">
    <div class="aw-page-head">
      <div>
        <p class="aw-kicker">
          workshop / projects
        </p>
        <h1>{{ t('menu.projects') }}</h1>
        <p class="sub">
          目标 → 计划 → 派发 → 交付 → 验收：Project Leader 编排，Channel 执行，成果逐级签核。
        </p>
      </div>
      <div class="head-acts">
        <button
          class="btn ghost"
          :disabled="loading"
          data-testid="projects-refresh"
          @click="load"
        >
          <span
            class="i-tabler-refresh"
            :class="{ spin: loading }"
          />
          刷新
        </button>
        <button
          class="aw-pill im"
          data-testid="projects-create"
          @click="openCreate"
        >
          <span class="i-tabler-plus im-pop" />
          新建项目
        </button>
      </div>
    </div>

    <!-- 统计带：全量口径（筛选不影响） -->
    <section class="stat-band">
      <div class="stat">
        <b>{{ stats.total }}</b><span>全部项目</span>
      </div>
      <div class="stat">
        <b class="tone-live">{{ stats.active }}</b><span>进行中</span>
      </div>
      <div class="stat">
        <b :class="stats.pending > 0 ? 'tone-warn' : ''">{{ stats.pending }}</b><span>待审批</span>
      </div>
      <div class="stat">
        <b class="tone-ok">{{ stats.completed }}</b><span>已完成</span>
      </div>
      <div class="stat">
        <b>{{ stats.workItems }}</b><span>工作项总量</span>
      </div>
    </section>

    <!-- 工具行 -->
    <div class="toolbar">
      <label class="search">
        <span
          class="i-tabler-search"
          aria-hidden="true"
        />
        <input
          v-model="keyword"
          type="search"
          placeholder="搜索项目名称 / 目标 / 描述"
          aria-label="搜索项目"
        >
      </label>
      <div
        class="seg"
        role="tablist"
        aria-label="按状态筛选"
      >
        <button
          v-for="f in filters"
          :key="f.key"
          type="button"
          role="tab"
          :aria-selected="statusFilter === f.key ? 'true' : 'false'"
          class="seg-item"
          :class="{ active: statusFilter === f.key }"
          @click="statusFilter = f.key"
        >
          {{ f.label }}<span class="seg-n">{{ f.n }}</span>
        </button>
      </div>
      <span class="toolbar-count">显示 {{ filtered.length }} / {{ projects.length }}</span>
    </div>

    <div
      v-if="error"
      class="error-bar"
      role="alert"
    >
      <span class="i-tabler-alert-triangle" />
      <span class="err-text">{{ error }}</span>
      <button
        class="btn ghost small"
        @click="load"
      >
        重试
      </button>
    </div>

    <!-- 骨架屏：首载才有，刷新时保留旧卡片避免闪白 -->
    <div
      v-if="loading && !projects.length"
      class="grid"
      aria-busy="true"
    >
      <div
        v-for="i in 6"
        :key="i"
        class="skeleton-card"
      >
        <div class="sk-line w40" />
        <div class="sk-line w80" />
        <div class="sk-line w60" />
        <div class="sk-bar" />
      </div>
    </div>

    <!-- 项目卡 -->
    <div
      v-else-if="filtered.length"
      class="grid aw-stagger"
      data-testid="projects-grid"
    >
      <NuxtLink
        v-for="p in filtered"
        :key="p.id"
        :to="`/projects/${p.id}`"
        class="pcard"
        :data-testid="`project-card-${p.id}`"
      >
        <header class="pc-head">
          <span
            class="pc-icon i-tabler-target-arrow"
            aria-hidden="true"
          />
          <div class="pc-title">
            <strong>{{ p.name }}</strong>
            <span class="pc-id mono">{{ p.id.slice(0, 8) }}</span>
          </div>
          <span
            class="pill"
            :class="p.status"
          >{{ statusLabel(p.status) }}</span>
        </header>

        <p class="pc-objective">
          {{ p.objective }}
        </p>

        <div class="pc-progress">
          <div class="pc-progress-row">
            <span>工作项 {{ p.summary?.completedWorkItems ?? 0 }}/{{ p.summary?.workItems ?? 0 }}</span>
            <b>{{ pct(p.summary?.progress) }}%</b>
          </div>
          <div class="bar">
            <i :style="{ width: `${pct(p.summary?.progress)}%` }" />
          </div>
        </div>

        <div class="pc-chips">
          <span
            class="chip"
            :class="{ warn: !p.summary?.channels }"
          >
            <span class="i-tabler-antenna" />
            {{ p.summary?.channels ?? 0 }} 频道
          </span>
          <span class="chip">
            <span class="i-tabler-package" />
            {{ p.summary?.approvedDeliverables ?? 0 }}/{{ p.summary?.deliverables ?? 0 }} 交付物
          </span>
          <span
            v-if="p.summary?.pendingApprovals"
            class="chip warn"
          >
            <span class="i-tabler-gavel" />
            {{ p.summary.pendingApprovals }} 待审批
          </span>
        </div>

        <footer class="pc-foot">
          <span class="mono">plan v{{ p.planVersion }} · {{ p.routingPolicy }}</span>
          <span class="pc-time">{{ relTime(p.summary?.lastActivityAt) }}</span>
        </footer>
      </NuxtLink>
    </div>

    <!-- 空态：区分"还没项目"与"筛不出来" -->
    <section
      v-else-if="!loading && projects.length"
      class="empty"
    >
      <span class="empty-icon i-tabler-filter-off" />
      <h2>没有符合条件的项目</h2>
      <p>换个关键词，或把状态筛选切回「全部」。</p>
      <button
        class="btn ghost"
        @click="keyword = ''; statusFilter = 'all'"
      >
        清除筛选
      </button>
    </section>

    <section
      v-else-if="!loading"
      class="empty"
      data-testid="projects-empty"
    >
      <span class="empty-icon i-tabler-briefcase" />
      <h2>还没有项目</h2>
      <p>一个项目 = 一个目标 + 一组交付物 + 一个 Project Leader。先建一个，再绑定执行 Channel。</p>
      <button
        class="aw-pill"
        @click="openCreate"
      >
        <span class="i-tabler-plus" />
        新建第一个项目
      </button>
    </section>

    <!-- 方法论条：空态/首屏都值得看的一屏四步 -->
    <section class="guide">
      <div class="guide-step">
        <span class="guide-n">01</span>
        <div><b>建项目</b><p>写清目标与验收口径，选择 Leader 引擎。</p></div>
      </div>
      <div class="guide-step">
        <span class="guide-n">02</span>
        <div><b>绑频道</b><p>把已有执行 Channel 绑定进来（受保护绑定不可强解）。</p></div>
      </div>
      <div class="guide-step">
        <span class="guide-n">03</span>
        <div><b>下发工作项</b><p>Leader 出计划，owner 批准后按依赖派发。</p></div>
      </div>
      <div class="guide-step">
        <span class="guide-n">04</span>
        <div><b>验收闭环</b><p>成果经 L1 复核与交付物签核后项目完成。</p></div>
      </div>
    </section>

    <!-- 创建对话框 -->
    <a-modal
      v-model:open="createOpen"
      :footer="null"
      :width="640"
      :destroy-on-close="false"
      title="新建项目"
      wrap-class-name="project-create-modal"
    >
      <div class="modal-body">
        <div class="form-grid">
          <label class="span2">
            <span>项目名称</span>
            <input
              v-model="form.name"
              placeholder="例如：A 线良率提升"
              maxlength="80"
            >
          </label>
          <label class="span2">
            <span>项目目标</span>
            <input
              v-model="form.objective"
              placeholder="例如：良率提升到 98%"
              maxlength="200"
            >
          </label>
          <label class="span2">
            <span>描述 / 范围 / 约束（可选）</span>
            <textarea
              v-model="form.description"
              rows="3"
              maxlength="600"
              placeholder="验收口径、不在范围内的事项、依赖…"
            />
          </label>
          <label>
            <span>Leader 引擎</span>
            <select v-model="form.leaderHarness">
              <option
                v-if="!availableHarnesses.length"
                value="mock"
              >
                mock（联调用）
              </option>
              <option
                v-for="h in harnesses"
                :key="h.id"
                :value="h.id"
                :disabled="!h.available"
              >
                {{ h.label }}{{ h.available ? '' : ' · 未安装' }}
              </option>
            </select>
          </label>
          <label>
            <span>放行口径</span>
            <select v-model="form.routingPolicy">
              <option value="technical">
                technical（上游成果技术验收后放行）
              </option>
              <option value="legacy">
                legacy（上游工作项终态即放行）
              </option>
            </select>
          </label>
          <label class="check-row span2">
            <input
              v-model="form.autoDispatch"
              type="checkbox"
            >
            <span>计划批准后自动派发就绪工作项（autoDispatch）</span>
          </label>
        </div>

        <p class="modal-hint">
          Leader 负责读现状、出计划、评审交付；执行由绑定的 Channel 完成。
          <template v-if="form.leaderHarness === 'mock'">
            mock 不调用 LLM，只用于联调与验收演示。
          </template>
        </p>

        <p
          v-if="createError"
          class="form-error"
        >
          {{ createError }}
        </p>

        <div class="modal-actions">
          <button
            class="btn ghost"
            @click="createOpen = false"
          >
            取消
          </button>
          <button
            class="btn"
            :disabled="creating || !form.name.trim() || !form.objective.trim() || !form.leaderHarness"
            data-testid="create-project-submit"
            @click="create"
          >
            {{ creating ? '创建中…' : '创建项目' }}
          </button>
        </div>

        <!-- 蓝图实例化：建频道 → 绑定 → 建计划 →（免批则）激活 -->
        <div
          v-if="blueprints.length"
          class="blueprint-box"
        >
          <header>
            <span class="i-tabler-stack-2" />
            <b>或从蓝图实例化</b>
          </header>
          <p>蓝图会一次性创建执行频道、绑定到新项目并生成计划（含交付物/工作项）。</p>
          <div class="blueprint-row">
            <select v-model="blueprintPick">
              <option value="">
                选择蓝图模板
              </option>
              <option
                v-for="b in blueprints"
                :key="b.id"
                :value="b.name"
              >
                {{ b.name }} · {{ b.channels.length }} 频道 · {{ b.routingPolicy }}
              </option>
            </select>
            <button
              class="btn ghost"
              :disabled="instantiating || !blueprintPick"
              @click="instantiate"
            >
              {{ instantiating ? '实例化中…' : '实例化' }}
            </button>
          </div>
        </div>
      </div>
    </a-modal>
  </div>
</template>

<style scoped>
.projects-page {
  max-width: 1180px;
  padding: 4px 4px 40px;
  margin: 0 auto;
}

.head-acts {
  display: flex;
  gap: 10px;
  align-items: center;
}

.btn {
  display: inline-flex;
  gap: 7px;
  align-items: center;
  justify-content: center;
  min-height: 36px;
  padding: 8px 14px;
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 600;
  color: var(--paper-raised);
  cursor: pointer;
  background: var(--ink);
  border: 1px solid transparent;
  border-radius: 10px;
  transition: opacity var(--transition-fast), border-color var(--transition-fast), background var(--transition-fast);
}

.btn:hover { opacity: 0.9; }
.btn:disabled { cursor: not-allowed; opacity: 0.45; }
.btn.ghost {
  color: var(--ink);
  background: transparent;
  border-color: var(--line-strong, var(--line));
}
.btn.ghost:hover { background: var(--paper-deep); opacity: 1; }
.btn.small { min-height: 32px; padding: 6px 10px; font-size: 12px; }

/* ── 统计带 ── */
.stat-band {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin: 4px 0 18px;
  overflow: hidden;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 14px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 14px 18px;
}

.stat + .stat { border-left: 1px solid var(--line); }
.stat b {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 24px;
  font-weight: 600;
  line-height: 1.1;
  color: var(--ink);
  letter-spacing: -0.02em;
}
.stat span { font-size: 11.5px; color: var(--ink-faint); }
.tone-live { color: var(--tone-info-dot) !important; }
.tone-warn { color: var(--tone-warning-dot) !important; }
.tone-ok { color: var(--tone-success-dot) !important; }

/* ── 工具行 ── */
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-bottom: 14px;
}

.search {
  display: flex;
  flex: 1 1 260px;
  gap: 8px;
  align-items: center;
  max-width: 380px;
  padding: 0 12px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 10px;
  transition: border-color var(--transition-fast);
}

.search:focus-within { border-color: var(--line-strong, var(--ink-fainter)); }
.search span { font-size: 15px; color: var(--ink-faint); }
.search input {
  width: 100%;
  height: 36px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--ink);
  background: transparent;
  border: 0;
  outline: none;
}
.search input::placeholder { color: var(--ink-fainter); }

.seg {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  background: var(--paper-deep);
  border-radius: 10px;
}

.seg-item {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 6px 11px;
  font-family: var(--font-body);
  font-size: 12.5px;
  color: var(--ink-soft);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.seg-item:hover { color: var(--ink); }
.seg-item.active {
  color: var(--ink);
  background: var(--paper-raised);
  box-shadow: 0 1px 3px rgb(12 10 9 / 8%);
}
.seg-n {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  color: var(--ink-faint);
}
.toolbar-count {
  margin-left: auto;
  font-size: 11.5px;
  color: var(--ink-faint);
}

.error-bar {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 14px;
  margin-bottom: 14px;
  font-size: 12.5px;
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
  border-radius: 10px;
}
.err-text { flex: 1 1 auto; }

/* ── 卡片栅格 ── */
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}

.pcard {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px 18px 14px;
  color: inherit;
  text-decoration: none;
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 14px;
  transition: border-color var(--transition-fast), box-shadow var(--transition-base), transform var(--transition-base);
}

.pcard:hover {
  border-color: var(--line-strong, var(--ink-fainter));
  box-shadow: 0 12px 30px rgb(12 10 9 / 7%);
  transform: translateY(-1px);
}
.pcard:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.pc-head {
  display: flex;
  gap: 10px;
  align-items: center;
}
.pc-icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  font-size: 16px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border-radius: 9px;
}
.pc-title {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.pc-title strong {
  overflow: hidden;
  font-size: 14px;
  font-weight: 650;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pc-id { font-size: 10.5px; color: var(--ink-faint); }

.pill {
  flex: 0 0 auto;
  padding: 3px 9px;
  font-size: 11px;
  font-weight: 600;
  line-height: 15px;
  color: var(--tone-neutral-dot);
  background: var(--tone-neutral-bg);
  border-radius: 999px;
}
.pill.active { color: var(--tone-info-dot); background: var(--tone-info-bg); }
.pill.draft { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.pill.paused { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.pill.completed { color: var(--tone-success-dot); background: var(--tone-success-bg); }
.pill.archived { color: var(--tone-neutral-dot); background: var(--tone-neutral-bg); }

.pc-objective {
  display: -webkit-box;
  min-height: 36px;
  margin: 0;
  overflow: hidden;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink-soft);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.pc-progress { display: flex; flex-direction: column; gap: 6px; }
.pc-progress-row {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--ink-faint);
}
.pc-progress-row b { font-family: var(--font-mono, monospace); color: var(--ink-soft); }
.bar {
  height: 4px;
  overflow: hidden;
  background: var(--paper-tint);
  border-radius: 999px;
}
.bar i {
  display: block;
  height: 100%;
  background: var(--accent);
  border-radius: inherit;
  transition: width var(--transition-base);
}

.pc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 3px 8px;
  font-size: 11px;
  color: var(--ink-soft);
  background: var(--paper-deep);
  border-radius: 7px;
}
.chip span[class^='i-tabler'] { font-size: 12px; color: var(--ink-faint); }
.chip.warn { color: var(--tone-warning-dot); background: var(--tone-warning-bg); }
.chip.warn span[class^='i-tabler'] { color: var(--tone-warning-dot); }

.pc-foot {
  display: flex;
  justify-content: space-between;
  padding-top: 10px;
  margin-top: auto;
  font-size: 10.5px;
  color: var(--ink-faint);
  border-top: 1px solid var(--line);
}
.mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }

/* ── 骨架屏 ── */
.skeleton-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 18px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 14px;
}
.sk-line, .sk-bar {
  height: 10px;
  background: linear-gradient(90deg, var(--paper-deep) 25%, var(--paper-tint) 50%, var(--paper-deep) 75%);
  background-size: 200% 100%;
  border-radius: 6px;
  animation: shimmer 1.4s ease-in-out infinite;
}
.sk-line.w40 { width: 40%; height: 14px; }
.sk-line.w80 { width: 80%; }
.sk-line.w60 { width: 60%; }
.sk-bar { height: 4px; margin-top: 8px; }
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* ── 空态 / 方法论 ── */
.empty {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  padding: 44px 20px 38px;
  text-align: center;
  background: var(--paper-raised);
  border: 1px dashed var(--line-strong, var(--line));
  border-radius: 16px;
}
.empty-icon { font-size: 30px; color: var(--ink-fainter); }
.empty h2 { margin: 0; font-size: 16px; font-weight: 650; color: var(--ink); }
.empty p { max-width: 460px; margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--ink-faint); }

.guide {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  padding-top: 18px;
  margin-top: 22px;
  border-top: 1px solid var(--line);
}
.guide-step { display: flex; gap: 10px; align-items: flex-start; }
.guide-n {
  flex: 0 0 auto;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--ink-faint);
  letter-spacing: 0.06em;
}
.guide-step b { display: block; margin-bottom: 2px; font-size: 12.5px; color: var(--ink); }
.guide-step p { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--ink-faint); }

/* ── 创建对话框 ── */
.modal-body { display: flex; flex-direction: column; gap: 14px; padding-top: 4px; }
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.form-grid label {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 11.5px;
  color: var(--ink-faint);
}
.form-grid .span2 { grid-column: 1 / -1; }
.form-grid input, .form-grid select, .form-grid textarea {
  width: 100%;
  padding: 9px 11px;
  font-family: var(--font-body);
  font-size: 13px;
  color: var(--ink);
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 10px;
  outline: none;
  transition: border-color var(--transition-fast);
}
.form-grid input:focus, .form-grid select:focus, .form-grid textarea:focus {
  border-color: var(--line-strong, var(--ink-fainter));
}
.form-grid textarea { resize: vertical; }
.check-row {
  flex-direction: row !important;
  gap: 8px !important;
  align-items: center;
  font-size: 12.5px !important;
  color: var(--ink-soft) !important;
}
.check-row input { width: auto; }
.modal-hint { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--ink-faint); }
.form-error {
  padding: 8px 12px;
  margin: 0;
  font-size: 12px;
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
  border-radius: 8px;
}
.modal-actions { display: flex; gap: 10px; justify-content: flex-end; }

.blueprint-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--paper-deep);
  border-radius: 12px;
}
.blueprint-box header {
  display: flex;
  gap: 7px;
  align-items: center;
  font-size: 12.5px;
  color: var(--ink);
}
.blueprint-box p { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--ink-faint); }
.blueprint-row { display: flex; gap: 8px; }
.blueprint-row select {
  flex: 1 1 auto;
  padding: 8px 10px;
  font-family: var(--font-body);
  font-size: 12.5px;
  color: var(--ink);
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: 9px;
}

.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

@media (max-width: 900px) {
  .stat-band { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .stat:nth-child(4), .stat:nth-child(5) { border-top: 1px solid var(--line); }
  .stat:nth-child(4) { border-left: 0; }
  .grid { grid-template-columns: 1fr; }
  .toolbar-count { display: none; }
  .form-grid { grid-template-columns: 1fr; }
}

@media (prefers-reduced-motion: reduce) {
  .sk-line, .sk-bar { animation: none; }
  .spin { animation: none; }
  .pcard:hover { transform: none; }
}
</style>
