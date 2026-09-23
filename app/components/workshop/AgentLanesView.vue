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
import { useEntitiesStore, type AgentView } from '@/app/stores/workshop/entities'
import { useWorkshopApi } from '@/app/composables/workshop/useWorkshopApi'
import { useLaneWidths } from '@/app/composables/workshop/useLaneWidths'
import { useChannelTerminals } from '@/app/composables/workshop/useChannelTerminals'
import LaneBlocks from '@/app/components/workshop/lanes/LaneBlocks.vue'
import LanesToolbar from '@/app/components/workshop/lanes/LanesToolbar.vue'
import LaneHeader from '@/app/components/workshop/lanes/LaneHeader.vue'
import AddMemberModal from '@/app/components/workshop/lanes/AddMemberModal.vue'
import EditMemberModal from '@/app/components/workshop/lanes/EditMemberModal.vue'
import OmpTerminalPanel from '@/app/components/workshop/terminal/OmpTerminalPanel.vue'

const { t } = useI18n()

const props = defineProps<{ channelId: string }>()
const entities = useEntitiesStore()
const api = useWorkshopApi()

const agents = computed(() => entities.agents[props.channelId] ?? [])

// ===== 泳道列宽拖拽调节(PaneSplitter;按 agentId 持久化,双击复位默认宽) =====
const { laneWidth, resizeLane, resetLane } = useLaneWidths()

// ===== 成员管理(用户侧 REST;状态回流以 WS agent.member 事件为准) =====
const memberModalOpen = ref(false)

// ===== 编辑成员(改名 / 改场景提示词 / 启停)=====
const editModalOpen = ref(false)
const editAgent = ref<AgentView | null>(null)

const openMemberModal = (): void => {
  memberModalOpen.value = true
}

const openEditMember = (a: AgentView): void => {
  editAgent.value = a
  editModalOpen.value = true
}

const removing = ref<string | null>(null)
const removeMember = async (agentId: string, name: string): Promise<void> => {
  removing.value = agentId
  try {
    await api.removeChannelAgent(props.channelId, agentId)
    message.success(t('agentLanesView.k1n3o03a052', { p0: name }))
  }
  catch (err) {
    message.error(t('agentLanesView.k13dsp10053', { p0: apiErrorMessage(err) }))
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
    message.error(t('agentLanesView.k139ec5j055', { p0: apiErrorMessage(err) }))
  }
  finally {
    stopping.value = null
  }
}

// ===== harness 终端控制(rpc-ui HITL;每成员独立 omp 会话) =====
const { terminalOf } = useChannelTerminals(() => props.channelId)

const terminalOpen = ref(false)
const terminalAgentId = ref<string | null>(null)
const terminalSubtitle = ref('')
const openTerminal = (a: { agentId: string, name: string, role: string }): void => {
  terminalAgentId.value = a.agentId
  terminalSubtitle.value = `${a.name} · ${a.role}`
  terminalOpen.value = true
}
</script>

<template>
  <div class="lanes-wrap">
    <LanesToolbar
      :agents="agents"
      @add="openMemberModal"
    />
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
          <LaneHeader
            :agent="a"
            :terminal="terminalOf.get(a.agentId)"
            :stopping="stopping"
            :removing="removing"
            @open-terminal="openTerminal"
            @edit="openEditMember"
            @stop="stopMember"
            @remove="removeMember"
          />
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

    <AddMemberModal
      v-model:open="memberModalOpen"
      :channel-id="channelId"
    />

    <EditMemberModal
      v-model:open="editModalOpen"
      :channel-id="channelId"
      :agent="editAgent"
    />
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
  color: var(--ink-faint);
}
.empty-title {
  margin: 0;
  font-size: 13px;
  color: var(--ink-soft);
}
.empty-hint {
  margin: 0;
  font-size: 11px;
  color: var(--ink-faint);
}

/* ── 窄屏(≤1023):泳道从"并排仪表"改为"一次一泳道"的横向卡片流 ──
   桌面 min-width 240px 的泳道在 390px 下并排 = 每列都被压到极限;
   改为 88% 宽 + scroll-snap:一屏一路信号,横扫切换成员。 */
@media (max-width: 1023.98px) {
  .empty-hint {
    font-size: 11.5px;
  }

  .lanes {
    padding: 8px;
    scroll-snap-type: x mandatory;
    -webkit-overflow-scrolling: touch;
  }

  .lane {
    flex: 0 0 88%;
    min-width: 0;
    scroll-snap-align: center;
  }

  .empty-title {
    font-size: 13px;
  }
}
</style>
