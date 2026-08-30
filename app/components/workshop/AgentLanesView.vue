<script setup lang="ts">
/**
 * Agent lanes 视图(P1):每个 agent 一列并排流(相邻面板范式,2-4 agent 最佳)。
 * 列头:状态徽标 + 队列上下文;列内:该 agent 的事件卡片(独立滚动)。
 * 团队成员管理(P3):添加成员(name/harness/role)/ 移除成员;lead 执行中自主管理的
 * 成员变更(agent.member 事件)同样在此实时呈现——实体列表是唯一状态源。
 *
 * harness 终端控制(rpc-ui HITL):每个 omp 成员 lane 可打开原生终端抽屉
 * (xterm 实时 TUI 渲染 + steer/follow_up 注入 + ask 对话框应答)。
 * 团队编排(任务指派/调度)仍由 channel 系统负责,终端是 harness 层的直接
 * 人类控制通道,二者互不干扰。omp lazy spawn:进程随首个任务启动,未启动时
 * 终端按钮仍可用(抽屉内等待 + 自动接入)。
 */
import { message } from 'ant-design-vue'
import { useStorage } from '@vueuse/core'
import { useEntitiesStore } from '@/app/stores/workshop/entities'
import { useWorkshopApi, type TerminalSessionDto } from '@/app/composables/workshop/useWorkshopApi'
import { agentHueColor } from '@/app/composables/workshop/useEventBlocks'
import LaneBlocks from '@/app/components/workshop/lanes/LaneBlocks.vue'
import OmpTerminalPanel from '@/app/components/workshop/terminal/OmpTerminalPanel.vue'

const { t } = useI18n()

const props = defineProps<{ channelId: string }>()
const entities = useEntitiesStore()
const api = useWorkshopApi()

const agents = computed(() => entities.agents[props.channelId] ?? [])

// ===== 泳道列宽拖拽调节(PaneSplitter;按 agentId 持久化,双击复位默认宽) =====
const LANE_W_DEFAULT = 320
const laneWidths = useStorage<Record<string, number>>('aw.harness.laneW', {})
const laneWidth = (id: string): number => laneWidths.value[id] ?? LANE_W_DEFAULT
const resizeLane = (id: string, d: number): void => {
  laneWidths.value = { ...laneWidths.value, [id]: Math.min(720, Math.max(240, laneWidth(id) + d)) }
}
const resetLane = (id: string): void => {
  const next = { ...laneWidths.value }
  Reflect.deleteProperty(next, id)
  laneWidths.value = next
}

/** 泳道身份:头像章 + 稳定身份色(与聊天头像/提及卡同一哈希色相源) */
const laneInitial = (name: string): string => name.trim().charAt(0).toUpperCase() || '?'
const laneHue = (id: string): string => agentHueColor(id)

/** harness 终端徽章色(antd 语义 → 本设计 tone 点;仅作指示,文字仍说明状态) */
const TERM_DOT: Record<string, string> = {
  processing: 'var(--tone-live-dot)',
  warning: 'var(--tone-warning-dot)',
  success: 'var(--tone-success-dot)',
}

// ===== 成员管理(用户侧 REST;状态回流以 WS agent.member 事件为准) =====
const memberModalOpen = ref(false)
const memberSubmitting = ref(false)
/** 添加模式:从零创建 / 从模板克隆 / 部署编组(批量) */
const addMode = ref<'create' | 'template' | 'team'>('create')
const memberForm = reactive({
  name: '',
  harness: 'omp' as 'omp' | 'mock' | 'claude',
  role: 'worker' as 'lead' | 'worker',
  systemPrompt: '',
})
/** 模板克隆 / 编组部署选项(弹窗打开时懒加载) */
const templates = ref<Array<{ id: string, name: string, harness: string, enabled: number }>>([])
const teams = ref<Array<{ id: string, name: string, memberCount: number, hasLead: boolean }>>([])
const selectedTemplateId = ref<string>('')
const selectedTeamId = ref<string>('')

const loadCatalog = async (): Promise<void> => {
  try {
    const [tplRes, teamRes] = await Promise.all([api.listTemplates(), api.listTeams()])
    templates.value = (tplRes.data ?? []).map(t => ({ id: t.id, name: t.name, harness: t.harness, enabled: t.enabled }))
    teams.value = (teamRes.data ?? []).map(t => ({
      id: t.id,
      name: t.name,
      memberCount: t.members.length,
      hasLead: t.members.some(m => m.role === 'lead'),
    }))
  }
  catch { /* 目录拉取失败:对应模式显示空并提示刷新 */ }
}

// ===== 编辑成员(改名 / 改场景提示词 / 启停)=====
const editModalOpen = ref(false)
const editSubmitting = ref(false)
const editForm = reactive({ agentId: '', name: '', role: 'worker' as 'lead' | 'worker', harness: '', systemPrompt: '' })
const openEditMember = (a: { agentId: string, name: string, role: string, harness: string, config?: Record<string, unknown> }): void => {
  editForm.agentId = a.agentId
  editForm.name = a.name
  editForm.role = a.role === 'lead' ? 'lead' : 'worker'
  editForm.harness = a.harness
  editForm.systemPrompt = typeof a.config?.systemPromptPrefix === 'string' ? a.config.systemPromptPrefix : ''
  editModalOpen.value = true
}
const submitEditMember = async (): Promise<void> => {
  const name = editForm.name.trim()
  if (!name) {
    message.warning(t('agentLanesView.ky6jqt4032'))
    return
  }
  editSubmitting.value = true
  try {
    await api.updateChannelAgent(props.channelId, editForm.agentId, {
      name,
      config: {
        // 保留既有 config,仅更新 systemPromptPrefix(编辑弹窗只暴露该字段)
        ...(entities.agents[props.channelId]?.find(a => a.agentId === editForm.agentId)?.config ?? {}),
        systemPromptPrefix: editForm.systemPrompt.trim(),
      },
      reason: t('agentLanesView.kfvflle033'),
    })
    message.success(t('agentLanesView.k21xjz2044', { p0: name }))
    editModalOpen.value = false
  }
  catch (err) {
    message.error(t('agentLanesView.k3jmrw1045', { p0: err instanceof Error ? err.message : String(err) }))
  }
  finally {
    editSubmitting.value = false
  }
}

const openMemberModal = (): void => {
  memberForm.name = ''
  memberForm.harness = 'omp'
  memberForm.role = 'worker'
  memberForm.systemPrompt = ''
  addMode.value = 'create'
  selectedTemplateId.value = ''
  selectedTeamId.value = ''
  memberModalOpen.value = true
  void loadCatalog()
}

const submitMember = async (): Promise<void> => {
  if (addMode.value === 'create') {
    const name = memberForm.name.trim()
    if (!name) {
      message.warning(t('agentLanesView.ky6jqt4032'))
      return
    }
    memberSubmitting.value = true
    try {
      await api.addChannelAgent(props.channelId, {
        name,
        harness: memberForm.harness,
        role: memberForm.role,
        config: memberForm.systemPrompt.trim()
          ? { systemPromptPrefix: memberForm.systemPrompt.trim() }
          : undefined,
      })
      message.success(t('agentLanesView.k1g5ykr3046', { p0: name }))
      memberModalOpen.value = false
    }
    catch (err) {
      message.error(t('agentLanesView.k1j97j74047', { p0: err instanceof Error ? err.message : String(err) }))
    }
    finally {
      memberSubmitting.value = false
    }
    return
  }
  if (addMode.value === 'template') {
    if (!selectedTemplateId.value) {
      message.warning(t('agentLanesView.k13xo8sz034'))
      return
    }
    memberSubmitting.value = true
    try {
      const tpl = templates.value.find(t => t.id === selectedTemplateId.value)
      await api.addChannelAgent(props.channelId, {
        agentId: selectedTemplateId.value,
        role: memberForm.role,
        config: memberForm.systemPrompt.trim()
          ? { systemPromptPrefix: memberForm.systemPrompt.trim() }
          : undefined,
      })
      message.success(t('agentLanesView.kk3uwzo048', { p0: memberForm.role, p1: tpl?.name ?? '' }))
      memberModalOpen.value = false
    }
    catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      message.error(`模板克隆失败${text.includes('LEAD_EXISTS') ? '(已有 lead,不能再添加 lead)' : `: ${text}`}`)
    }
    finally {
      memberSubmitting.value = false
    }
    return
  }
  // 部署编组:批量克隆全部成员模板(lead 冲突由服务端 409 拒绝)
  if (!selectedTeamId.value) {
    message.warning(t('agentLanesView.k1tjd5ab035'))
    return
  }
  memberSubmitting.value = true
  try {
    const team = teams.value.find(t => t.id === selectedTeamId.value)
    await api.deployTeam(selectedTeamId.value, props.channelId)
    message.success(t('agentLanesView.k1gslqf9050', { p0: team?.name ?? '', p1: team?.memberCount ?? 0 }))
    memberModalOpen.value = false
  }
  catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    message.error(`编组部署失败${text.includes('LEAD_EXISTS') ? '(channel 已有 lead,编组内 lead 成员冲突;请先移除现有 lead 或选用无 lead 编组)' : `: ${text}`}`)
  }
  finally {
    memberSubmitting.value = false
  }
}

const removing = ref<string | null>(null)
const removeMember = async (agentId: string, name: string): Promise<void> => {
  removing.value = agentId
  try {
    await api.removeChannelAgent(props.channelId, agentId)
    message.success(t('agentLanesView.k1n3o03a052', { p0: name }))
  }
  catch (err) {
    message.error(t('agentLanesView.k13dsp10053', { p0: err instanceof Error ? err.message : String(err) }))
  }
  finally {
    removing.value = null
  }
}

// ===== HITL:独立中断成员运行时(worker/lead 均可;成员保留,下次任务自动重装配) =====
const stopping = ref<string | null>(null)
const stopMember = async (agentId: string, name: string): Promise<void> => {
  stopping.value = agentId
  try {
    await api.stopChannelAgent(props.channelId, agentId)
    message.success(t('agentLanesView.kcpbv47054', { p0: name }))
  }
  catch (err) {
    message.error(t('agentLanesView.k139ec5j055', { p0: err instanceof Error ? err.message : String(err) }))
  }
  finally {
    stopping.value = null
  }
}

// ===== harness 终端控制(rpc-ui HITL;每成员独立 omp 会话) =====
const terminals = ref<TerminalSessionDto[]>([])
/** agentId → 存活终端会话(lane 头徽标 + 终端按钮态) */
const terminalOf = computed(() => {
  const map = new Map<string, TerminalSessionDto>()
  for (const t of terminals.value) {
    if (!t.alive || !t.agentId) continue
    map.set(t.agentId, t)
  }
  return map
})
const termBadge = (t: TerminalSessionDto | undefined): { text: string, color: string } | null => {
  if (!t) return null
  if (t.streaming) return { text: 'streaming', color: 'processing' }
  if (t.running) return { text: 'turn', color: 'warning' }
  return { text: 'idle', color: 'success' }
}

let terminalsTimer: ReturnType<typeof setInterval> | null = null
const loadTerminals = async (): Promise<void> => {
  try {
    const res = await api.listChannelTerminals(props.channelId)
    terminals.value = res.data ?? []
  }
  catch { /* 轮询失败静默(下次恢复) */ }
}

const terminalOpen = ref(false)
const terminalAgentId = ref<string | null>(null)
const terminalSubtitle = ref('')
const openTerminal = (a: { agentId: string, name: string, role: string }): void => {
  terminalAgentId.value = a.agentId
  terminalSubtitle.value = `${a.name} · ${a.role}`
  terminalOpen.value = true
}

onMounted(() => {
  void loadTerminals()
  terminalsTimer = setInterval(() => void loadTerminals(), 5000)
})
onBeforeUnmount(() => {
  if (terminalsTimer) clearInterval(terminalsTimer)
})
</script>

<template>
  <div class="lanes-wrap">
    <div class="toolbar">
      <div class="team-summary">
        <span class="ts-label">{{ $t('agentLanesView.k3y5ja016') }}</span>
        <span class="ts-count">{{ agents.length }}</span>
        <span class="ts-unit">{{ $t('agentLanesView.k3ll6sa017') }}</span>
        <span class="ts-detail">lead {{ agents.filter(a => a.role === 'lead').length }} · worker {{ agents.filter(a => a.role === 'worker').length }}</span>
      </div>
      <a-button
        size="small"
        type="primary"
        ghost
        @click="openMemberModal"
      >
        <span class="i-tabler-user-plus" />
        <span>{{ $t('agentLanesView.k1fmutgo018') }}</span>
      </a-button>
    </div>
    <div class="lanes">
      <div
        v-if="agents.length === 0"
        class="empty"
      >
        <!-- 快照未到 → 同步中;真无成员 → 空态指引(诚实区分,不永挂"等待") -->
        <template v-if="!entities.channels[channelId]">
          <span class="i-tabler-refresh empty-icon" />
          <p class="empty-title">
            {{ $t('agentLanesView.k1woev5v019') }}
          </p>
        </template>
        <template v-else>
          <span class="i-tabler-users-group empty-icon" />
          <p class="empty-title">
            {{ $t('agentLanesView.k122h4pc020') }}
          </p>
          <p class="empty-hint">
            {{ $t('agentLanesView.k7cr2h8021') }}
          </p>
        </template>
      </div>
      <template
        v-for="a in agents"
        :key="a.agentId"
      >
        <div
          class="lane"
          :style="{ flexBasis: `${laneWidth(a.agentId)}px` }"
        >
          <div class="lane-head">
            <!-- 第一行:身份(头像章 + 名称 + 中性徽标);名称为弹性吸收项,任意宽度截断不遮挡 -->
            <div class="head-top">
              <span class="lane-ava">
                <span :style="{ '--av': laneHue(a.agentId) }">{{ laneInitial(a.name) }}</span>
                <span
                  class="lane-state"
                  :class="a.state"
                />
              </span>
              <span
                class="lane-name"
                :title="a.name"
              >{{ a.name }}</span>
              <span
                v-if="a.config?.systemPromptPrefix"
                class="lane-chip"
                :title="$t('agentLanesView.k107s4am001')"
              >
                {{ $t('agentLanesView.k3xycu022') }}
              </span>
              <span
                class="lane-role"
                :class="a.role"
              >
                {{ a.role }}
              </span>
              <span
                v-if="termBadge(terminalOf.get(a.agentId))"
                class="term-badge"
                :title="$t('agentLanesView.k1wn2vmt036', { p0: terminalOf.get(a.agentId)?.pid })"
              >
                <span
                  class="term-dot"
                  :style="{ background: TERM_DOT[termBadge(terminalOf.get(a.agentId))!.color] ?? 'var(--tone-neutral-dot)' }"
                />
                {{ termBadge(terminalOf.get(a.agentId))!.text }}
              </span>
            </div>
            <!-- 第二行:状态摘要 + 操作簇(常驻可见;hairline 分隔破坏性操作) -->
            <div class="head-sub">
              <span class="lane-meta">
                <template v-if="a.state === 'busy' && a.currentTaskTitle">
                  {{ a.currentTaskTitle }}
                  <span
                    v-if="a.currentTaskProgress != null"
                    class="lane-progress"
                  >{{ a.currentTaskProgress }}%</span>
                </template>
                <template v-else>{{ a.state }} · Q{{ a.queued ?? 0 }}</template>
              </span>
              <div class="lane-actions">
                <a-button
                  v-if="a.harness === 'omp'"
                  size="small"
                  type="primary"
                  ghost
                  class="lane-term"
                  :title="$t('agentLanesView.k1884q17002')"
                  @click="openTerminal(a)"
                >
                  <span class="i-tabler-terminal-2" />
                  <span class="term-label">{{ $t('agentLanesView.k4588s023') }}</span>
                </a-button>
                <a-button
                  size="small"
                  type="text"
                  class="lane-edit"
                  :title="$t('agentLanesView.k1pgd3tf003')"
                  @click="openEditMember(a)"
                >
                  <span class="i-tabler-edit" />
                </a-button>
                <span class="actions-divider" />
                <a-popconfirm
                  :title="$t('agentLanesView.k1l029kf037', { p0: a.name })"
                  ok-text="停止"
                  cancel-text="取消"
                  @confirm="stopMember(a.agentId, a.name)"
                >
                  <a-button
                    size="small"
                    type="text"
                    class="lane-stop"
                    :loading="stopping === a.agentId"
                    title="HITL 停止该 Agent 运行时"
                  >
                    <span class="i-tabler-player-stop" />
                  </a-button>
                </a-popconfirm>
                <a-popconfirm
                  :title="$t('agentLanesView.kt3n27m038', { p0: a.name })"
                  ok-text="移除"
                  cancel-text="取消"
                  @confirm="removeMember(a.agentId, a.name)"
                >
                  <a-button
                    size="small"
                    type="text"
                    danger
                    class="lane-remove"
                    :loading="removing === a.agentId"
                  >
                    <span class="i-tabler-x" />
                  </a-button>
                </a-popconfirm>
              </div>
            </div>
          </div>
          <div class="lane-body">
            <!-- 列体:同类型连续事件聚合为块组件(实时/历史同一路径,无重复消费;
                 宽度随泳道拖拽自适应,EventBlock 26px+1fr 网格自收缩) -->
            <LaneBlocks
              :channel-id="channelId"
              :agent-id="a.agentId"
            />
          </div>
        </div>
        <!-- 泳道分隔条:每列右侧都挂(含最右列);统一调节"其左侧泳道"的宽度,
             尾条即最右泳道的右缘调节柄(双击复位;键盘 ←→ 微调) -->
        <workshop-pane-splitter
          :label="$t('agentLanesView.k7xt1y6039', { p0: a.name })"
          @resize="d => resizeLane(a.agentId, d)"
          @reset="resetLane(a.agentId)"
        />
      </template>
    </div>

    <!-- 添加成员弹窗(三模式:从零创建 / 模板克隆 / 编组部署) -->
    <a-modal
      v-model:open="memberModalOpen"
      :title="$t('agentLanesView.k17kcn55004')"
      :confirm-loading="memberSubmitting"
      ok-text="添加"
      cancel-text="取消"
      @ok="submitMember"
    >
      <a-radio-group
        v-model:value="addMode"
        class="mode-switch"
      >
        <a-radio-button value="create">
          {{ $t('agentLanesView.k1b7cwvy024') }}
        </a-radio-button>
        <a-radio-button value="template">
          {{ $t('agentLanesView.k1ndey1w025') }}
        </a-radio-button>
        <a-radio-button value="team">
          {{ $t('agentLanesView.k1l5qyux026') }}
        </a-radio-button>
      </a-radio-group>

      <!-- 模式一:从零创建 -->
      <a-form
        v-if="addMode === 'create'"
        layout="vertical"
        class="member-form"
      >
        <a-form-item :label="$t('agentLanesView.k3nufdm005')">
          <a-input
            v-model:value="memberForm.name"
            placeholder="如 db-migrator / test-writer"
            @press-enter="submitMember"
          />
        </a-form-item>
        <a-form-item label="harness">
          <a-radio-group v-model:value="memberForm.harness">
            <a-radio value="omp">
              omp(完整 LLM agent)
            </a-radio>
            <a-radio value="mock">
              {{ $t('agentLanesView.kqg6783027') }}
            </a-radio>
            <a-radio value="claude">
              claude
            </a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item :label="$t('agentLanesView.k479op006')">
          <a-radio-group v-model:value="memberForm.role">
            <a-radio value="worker">
              worker
            </a-radio>
            <a-radio value="lead">
              {{ $t('agentLanesView.k1weovo028') }}
            </a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item :label="$t('agentLanesView.kaogfp007')">
          <a-textarea
            v-model:value="memberForm.systemPrompt"
            :rows="3"
            :placeholder="$t('agentLanesView.kbqn6w5008')"
          />
        </a-form-item>
      </a-form>

      <!-- 模式二:从已有模板克隆 -->
      <a-form
        v-else-if="addMode === 'template'"
        layout="vertical"
        class="member-form"
      >
        <a-form-item label="选择 Agent 模板(克隆 name/harness/config 为独立实例)">
          <a-select
            v-model:value="selectedTemplateId"
            :placeholder="$t('agentLanesView.kung925009')"
            :options="templates.map(t => ({ value: t.id, label: `${t.name}(${t.harness})${t.enabled === 0 ? ' · 已停用' : ''}` }))"
          />
        </a-form-item>
        <a-form-item :label="$t('agentLanesView.k1bl78fu010')">
          <a-radio-group v-model:value="memberForm.role">
            <a-radio value="worker">
              worker
            </a-radio>
            <a-radio value="lead">
              {{ $t('agentLanesView.k1weovo028') }}
            </a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item :label="$t('agentLanesView.k1vhvbz7011')">
          <a-textarea
            v-model:value="memberForm.systemPrompt"
            :rows="3"
            :placeholder="$t('agentLanesView.k7ft6ig012')"
          />
        </a-form-item>
        <div class="mode-hint">
          {{ $t('agentLanesView.knybb6r029') }}
        </div>
      </a-form>

      <!-- 模式三:部署 AgentTeam(批量) -->
      <a-form
        v-else
        layout="vertical"
        class="member-form"
      >
        <a-form-item :label="$t('agentLanesView.k29om9b013')">
          <a-select
            v-model:value="selectedTeamId"
            :placeholder="$t('agentLanesView.kur1otz014')"
            :options="teams.map(t => ({ value: t.id, label: $t('agentLanesView.k1qcmxyu040', { p0: t.name, p1: t.memberCount, p2: t.hasLead ? ',含 lead' : '' }) }))"
          />
        </a-form-item>
        <div class="mode-hint">
          {{ $t('agentLanesView.k1qqnq5030') }}
        </div>
      </a-form>
    </a-modal>

    <!-- 编辑成员(名 / 场景提示词) -->
    <a-modal
      v-model:open="editModalOpen"
      :title="$t('agentLanesView.k19j5rho041', { p0: editForm.name || '' })"
      :confirm-loading="editSubmitting"
      ok-text="保存"
      cancel-text="取消"
      @ok="submitEditMember"
    >
      <a-form
        layout="vertical"
        class="member-form"
      >
        <a-form-item :label="$t('agentLanesView.k3nufdm005')">
          <a-input v-model:value="editForm.name" />
        </a-form-item>
        <a-form-item label="角色 / harness">
          <a-space>
            <a-tag :color="editForm.role === 'lead' ? 'purple' : 'blue'">
              {{ editForm.role }}
            </a-tag>
            <a-tag>{{ editForm.harness }}</a-tag>
          </a-space>
        </a-form-item>
        <a-form-item label="场景系统提示词(systemPromptPrefix)">
          <a-textarea
            v-model:value="editForm.systemPrompt"
            :rows="6"
            :placeholder="$t('agentLanesView.k10ti81i015')"
          />
          <template #extra>
            <span class="ws-hint">{{ $t('agentLanesView.k1rw1rd2031') }}</span>
          </template>
        </a-form-item>
      </a-form>
    </a-modal>
    <!-- harness 原生终端(omp rpc-ui 镜像 · 每成员独立会话 · HITL 控制) -->
    <OmpTerminalPanel
      v-model:open="terminalOpen"
      :agent-id="terminalAgentId"
      :channel-id="channelId"
      :pid="null"
      :subtitle="terminalSubtitle"
    />
  </div>
</template>

<style scoped>
.lanes-wrap {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--paper); /* 灰画布:气泡白卡在此浮出(Slack 声部分层) */
}
.toolbar {
  display: flex;
  flex: 0 0 auto;
  gap: 12px;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  padding: 8px 14px 6px;
  background: var(--paper-raised);
  border-bottom: 1px solid var(--line);
}
.team-summary {
  display: flex;
  flex: 1 1 auto;
  gap: 7px;
  min-width: 0;
  align-items: baseline;
}
.ts-label {
  flex: 0 0 auto;
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
}
.ts-count {
  flex: 0 0 auto;
  font-size: 15px;
  font-weight: 700;
  line-height: 1;
  color: var(--ink);
}
.ts-unit {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--ink-faint);
}
.ts-detail {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 11px;
  font-family: var(--font-mono);
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.lanes {
  overscroll-behavior: contain;
  display: flex;
  flex: 1 1 auto;
  gap: 10px;
  width: 100%;
  min-width: 0;
  min-height: 0;
  padding: 8px 12px 12px;
  overflow-x: auto;
  overflow-y: hidden;
}
.lane {
  display: flex;
  flex: 0 0 auto; /* 宽度由拖拽分隔条驱动(inline flexBasis) */
  flex-direction: column;
  min-width: 240px;
  background: var(--paper-raised);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel);
  box-shadow: var(--shadow-card);
  container-type: inline-size; /* 泳道自身为容器:窄列时内部自适应 */
}
/* 双层头部:第一行身份(头像/名/徽标),第二行状态摘要 + 操作簇 ——
   单行方案在 320px 列内固定元素 ~360px 必然挤压遮挡,分层后各行均有余量 */
.lane-head {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px 9px;
  font-size: 13px;
  border-bottom: 1px solid var(--line);
}
.head-top {
  display: flex;
  gap: 7px;
  min-width: 0;
  align-items: center;
}
/* 身份头像章:稳定身份色 + 白首字母;右下状态 pip(busy 呼吸 / stopped 红 / idle 静灰) */
.lane-ava {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 11px;
  font-weight: 600;
  color: var(--on-av);
  border-radius: var(--radius-panel-sm);
}
.lane-ava > span:first-child {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: var(--av, var(--av-fallback));
  border-radius: var(--radius-panel-sm);
}
.lane-state {
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 8px;
  height: 8px;
  background: var(--ink-fainter);
  border: 1.5px solid var(--paper-raised);
  border-radius: 50%;
}
.lane-state.busy {
  background: var(--tone-live-dot);
  animation: lane-breathe 1.9s ease-in-out infinite;
}
.lane-state.stopped { background: var(--tone-danger-dot); }
@keyframes lane-breathe {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .lane-state.busy { animation: none; opacity: 0.9; }
}
.lane-name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 中性小徽标:场景/角色/终端 —— 发丝线 chip 或墨色填充,不再叠 antd 多色 tag */
.lane-chip {
  flex: 0 0 auto;
  padding: 0 6px;
  font-size: 9.5px;
  letter-spacing: 0.04em;
  line-height: 15px;
  color: var(--ink-faint);
  background: transparent;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.lane-role {
  flex: 0 0 auto;
  padding: 0 7px;
  font-size: 9.5px;
  letter-spacing: 0.05em;
  line-height: 16px;
  text-transform: uppercase;
  border-radius: var(--radius-pill);
}
.lane-role.lead {
  color: var(--on-accent);
  background: var(--accent);
}
.lane-role.worker {
  color: var(--ink-soft);
  border: 1px solid var(--line-strong);
}
.term-badge {
  display: inline-flex;
  gap: 4px;
  flex: 0 0 auto;
  align-items: center;
  padding: 0 6px;
  font-family: var(--font-mono);
  font-size: 9px;
  line-height: 15px;
  color: var(--ink-faint);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
}
.term-badge .term-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}
.head-sub {
  display: flex;
  gap: 8px;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
}
.lane-meta {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  font-size: 10.5px;
  font-family: var(--font-mono);
  color: var(--ink-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 执行中进度:busy 时展示当前任务标题 + 进度 %(leader 对 worker 推进的实时可见性) */
.lane-progress {
  display: inline-flex;
  align-items: center;
  padding: 0 5px;
  margin-left: 4px;
  color: var(--tone-info-dot);
  background: color-mix(in srgb, var(--tone-info-dot) 10%, transparent);
  border-radius: var(--radius-pill);
}
/* 操作簇:统一浅底胶囊分组,常驻可见(hover 提亮);hairline 分隔破坏性操作 */
.lane-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 5px;
  align-items: center;
  padding: 2px;
  background: var(--hover-tint);
  border-radius: var(--radius-chip);
}
.lane-actions .ant-btn {
  font-size: 12px;
  opacity: 0.78;
  transition: opacity 0.15s ease;
}
.lane-head:hover .lane-actions .ant-btn { opacity: 1; }
.actions-divider {
  flex: 0 0 auto;
  width: 1px;
  height: 14px;
  margin-inline: 2px;
  background: color-mix(in srgb, currentColor 16%, transparent);
}
.lane-term { padding-inline: 7px; }
.lane-edit,
.lane-stop,
.lane-remove { padding-inline: 5px; }
.term-label {
  display: none;
  margin-inline-start: 5px;
}
/* 窄泳道渐进披露(<300px 场景徽标让位;<260px 终端徽标让位;操作簇永不隐藏) */
@container (min-width: 380px) {
  .term-label { display: inline; }
}
@container (max-width: 300px) {
  .lane-chip { display: none; }
}
@container (max-width: 260px) {
  .term-badge { display: none; }
}
.lane-body {
  overscroll-behavior: contain;
  flex: 1 1 auto;
  min-height: 0;
  padding: 8px 4px 16px;
  overflow-y: auto;
  background: var(--paper); /* 灰画布:消息气泡白卡浮出 */
}
.empty {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 6px;
  align-items: center;
  justify-content: center;
  padding: 32px 12px;
  color: var(--ink-faint);
  font-size: 12px;
  text-align: center;
}
.empty-icon {
  font-size: 22px;
  color: var(--ink-fainter);
}
.empty-title {
  margin: 0;
  font-size: 13px;
  color: var(--ink-soft);
}
.empty-hint {
  margin: 0;
  font-size: 11px;
  color: var(--ink-fainter);
}
.member-form { margin-top: 8px; }
.mode-switch { margin-top: 4px; }
.mode-hint {
  padding: 6px 8px;
  font-size: 11px;
  opacity: 0.6;
  background: color-mix(in srgb, currentColor 5%, transparent);
  border-radius: var(--radius-chip);
}
</style>
