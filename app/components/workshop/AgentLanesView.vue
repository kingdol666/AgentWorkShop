<script setup lang="ts">
/**
 * Agent lanes 视图(P1):每个 agent 一列并排流(相邻面板范式,2-4 agent 最佳)。
 * 列头:状态徽标 + 队列上下文;列内:该 agent 的事件卡片(独立滚动)。
 * 团队成员管理(P3):添加成员(name/harness/role)/ 移除成员;lead 执行中自主管理的
 * 成员变更(agent.member 事件)同样在此实时呈现——实体列表是唯一状态源。
 */
import { message } from 'ant-design-vue'
import { useEntitiesStore } from '../../stores/workshop/entities'
import { useEventsStore } from '../../stores/workshop/events'
import { useWorkshopApi } from '../../composables/workshop/useWorkshopApi'

const props = defineProps<{ channelId: string }>()
const entities = useEntitiesStore()
const events = useEventsStore()
const api = useWorkshopApi()

const agents = computed(() => entities.agents[props.channelId] ?? [])

const laneEvents = (agentId: string) =>
  events.ring(props.channelId).items.filter(e => e.agentId === agentId)

const stateDot: Record<string, string> = {
  idle: '#52c41a',
  busy: '#1677ff',
  stopped: '#8c8c8c',
}

// ===== 成员管理(用户侧 REST;状态回流以 WS agent.member 事件为准) =====
const memberModalOpen = ref(false)
const memberSubmitting = ref(false)
const memberForm = reactive({
  name: '',
  harness: 'omp' as 'omp' | 'mock' | 'claude',
  role: 'worker' as 'lead' | 'worker',
  systemPrompt: '',
})

const openMemberModal = (): void => {
  memberForm.name = ''
  memberForm.harness = 'omp'
  memberForm.role = 'worker'
  memberForm.systemPrompt = ''
  memberModalOpen.value = true
}

const submitMember = async (): Promise<void> => {
  const name = memberForm.name.trim()
  if (!name) {
    message.warning('成员名不能为空')
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
    message.success(`成员 ${name} 已添加(等待 agent.member 事件回流对齐)`)
    memberModalOpen.value = false
  }
  catch (err) {
    message.error(`添加成员失败: ${err instanceof Error ? err.message : String(err)}`)
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
    message.success(`成员 ${name} 已移除`)
  }
  catch (err) {
    message.error(`移除成员失败: ${err instanceof Error ? err.message : String(err)}`)
  }
  finally {
    removing.value = null
  }
}
</script>

<template>
  <div class="lanes-wrap">
    <div class="toolbar">
      <span class="team-count">团队 {{ agents.length }} 人(lead {{ agents.filter(a => a.role === 'lead').length }} / worker {{ agents.filter(a => a.role === 'worker').length }})</span>
      <a-button
        size="small"
        type="primary"
        ghost
        @click="openMemberModal"
      >
        ➕ 添加成员
      </a-button>
    </div>
    <div class="lanes">
      <div
        v-if="agents.length === 0"
        class="empty"
      >
        等待成员快照…
      </div>
      <div
        v-for="a in agents"
        :key="a.agentId"
        class="lane"
      >
        <div class="lane-head">
          <span
            class="dot"
            :style="{ background: stateDot[a.state] ?? '#8c8c8c' }"
          />
          <span class="lane-name">{{ a.name }}</span>
          <a-tag
            :color="a.role === 'lead' ? 'purple' : 'blue'"
            class="role"
          >
            {{ a.role }}
          </a-tag>
          <span class="lane-meta">{{ a.state }} · Q{{ a.queued ?? 0 }}</span>
          <a-popconfirm
            :title="`移除成员 ${a.name}?其排队任务将自动回收`"
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
              ✕
            </a-button>
          </a-popconfirm>
        </div>
        <div class="lane-body">
          <div
            v-if="laneEvents(a.agentId).length === 0"
            class="lane-empty"
          >
            暂无事件
          </div>
          <workshop-event-card
            v-for="e in laneEvents(a.agentId)"
            :key="`${e.seq}-${e.type}`"
            :event="e"
          />
        </div>
      </div>
    </div>

    <!-- 添加成员弹窗 -->
    <a-modal
      v-model:open="memberModalOpen"
      title="添加团队成员"
      :confirm-loading="memberSubmitting"
      ok-text="添加"
      cancel-text="取消"
      @ok="submitMember"
    >
      <a-form
        layout="vertical"
        class="member-form"
      >
        <a-form-item label="成员名">
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
              mock(测试剧本)
            </a-radio>
            <a-radio value="claude">
              claude
            </a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="角色">
          <a-radio-group v-model:value="memberForm.role">
            <a-radio value="worker">
              worker
            </a-radio>
            <a-radio value="lead">
              lead(至多一个,已有 lead 会被拒绝)
            </a-radio>
          </a-radio-group>
        </a-form-item>
        <a-form-item label="系统提示词前缀(可选,定义成员专长)">
          <a-textarea
            v-model:value="memberForm.systemPrompt"
            :rows="3"
            placeholder="如:你是数据库迁移专家,专注 schema 变更与数据回填…"
          />
        </a-form-item>
      </a-form>
    </a-modal>
  </div>
</template>

<style scoped>
.lanes-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.toolbar {
  display: flex;
  gap: 10px;
  align-items: center;
  justify-content: flex-end;
  padding: 6px 12px 0;
}
.team-count {
  flex: 1 1 auto;
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  opacity: 0.55;
}
.lanes {
  display: flex;
  flex: 1 1 auto;
  gap: 8px;
  min-height: 0;
  padding: 8px;
  overflow-x: auto;
}
.lane {
  display: flex;
  flex: 0 0 320px;
  flex-direction: column;
  min-width: 260px;
  border: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  border-radius: 8px;
}
.lane-head {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 8px 10px;
  font-size: 13px;
  border-bottom: 1px solid color-mix(in srgb, currentColor 10%, transparent);
}
.dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
.lane-name { font-weight: 700; }
.role { margin-inline-end: 0; font-size: 10px; line-height: 14px; }
.lane-meta {
  flex: 1 1 auto;
  font-size: 11px;
  font-family: ui-monospace, Consolas, monospace;
  opacity: 0.5;
  text-align: right;
}
.lane-remove { flex: 0 0 auto; font-size: 11px; }
.lane-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
.lane-empty,
.empty {
  padding: 20px 8px;
  font-size: 12px;
  opacity: 0.4;
  text-align: center;
}
.member-form { margin-top: 8px; }
</style>
