<script setup lang="ts">
/**
 * NotificationCenter —— 用户级通知铃铛(v17 主计划 §6,前端)。
 *
 * 与 HITL 铃标(agent 待办)并列但语义不同:这里是**按 recipientUserId 定向**的用户通知
 * (被 @ / Agent 回复 / 审批请求与结果 / 成员变更)。投递隔离在服务端完成,
 * 前端只负责:幂等展示(eventId 去重)、未读徽标、点击跳转、实时提示。
 *
 * 视觉语言沿用页头既有铃标:幽灵图标钮 + 角标 + 下拉列表(不另造一套)。
 * 实时到达用 antd `message`(与全站 toast 同源),补拉/快照**不弹窗**(避免重连刷屏)。
 */
import { message } from 'ant-design-vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useNotificationsStore } from '@/app/stores/workshop/notifications'
import { useWorkspacesStore } from '@/app/stores/workshop/workspaces'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'
import type { AepNotification, AepNotificationType } from '#shared/workshop-protocol'

const notifications = useNotificationsStore()
const wsStore = useWorkspacesStore()
const { hostNotifications } = useWorkshopWs()

const open = ref(false)
const releaseHost = ref<(() => void) | null>(null)

onMounted(async () => {
  // 宿主用户级通知订阅(引用计数:两处宿主只发一次 subNotifications)
  releaseHost.value = hostNotifications()
  // 首屏对齐:快照是事实源;已加载过则按游标补拉(重连/换页不丢不重)
  if (notifications.loaded) await notifications.backfill()
  else await notifications.loadSnapshot()
})

onBeforeUnmount(() => {
  releaseHost.value?.()
  releaseHost.value = null
})

/** 实时通知 → 轻提示(仅直播帧触发;补拉不弹,防重连刷屏) */
watch(() => notifications.liveSeq, () => {
  const n = notifications.liveItem
  if (!n) return
  message.info({
    content: `${n.title}${n.body ? ` · ${n.body.slice(0, 60)}` : ''}`,
    duration: 6,
    onClick: () => void openNotification(n),
  })
})

const TYPE_META: Record<AepNotificationType, { label: string, icon: string, tone: string }> = {
  mention: { label: '@ 提及', icon: 'i-tabler-at', tone: 'mention' },
  agent_reply: { label: 'Agent 回复', icon: 'i-tabler-robot', tone: 'reply' },
  hitl_request: { label: '待审批', icon: 'i-tabler-alert-triangle', tone: 'hitl' },
  hitl_resolved: { label: '审批结果', icon: 'i-tabler-circle-check', tone: 'ok' },
  member: { label: '成员变更', icon: 'i-tabler-user-plus', tone: 'info' },
}

const badge = computed(() => (notifications.unreadCount > 99 ? '99+' : String(notifications.unreadCount)))

/** 点击通知:先标已读,再跳到对应界面(群聊消息 → 该频道群聊;审批 → 运行时监控) */
async function openNotification(n: AepNotification): Promise<void> {
  open.value = false
  if (!n.readAt) {
    try {
      await notifications.markRead({ id: n.id })
    }
    catch { /* 已读失败不阻塞跳转 */ }
  }
  if (n.hitlKind || n.hitlId || n.type === 'hitl_request') {
    // 与页头 HITL 铃标同一落点:运行时监控(带 agent/channel 定位)
    await navigateTo({ path: '/monitor', query: { agentId: String(n.payload?.agentId ?? ''), channelId: n.channelId ?? '' } })
    return
  }
  if (!n.channelId) return
  if (!wsStore.loaded) {
    try {
      await wsStore.load()
    }
    catch { /* workspace 列表失败:退回工作台总览 */ }
  }
  const ws = wsStore.workspaces.find(w => w.channelIds.includes(n.channelId as string))
  if (!ws) {
    await navigateTo('/workshop')
    return
  }
  // 聚焦该频道 + 直达群聊视图(view 深链与 [wsId].vue 的 VIEW_VALUES 一致)
  wsStore.setActiveChannel(ws.id, n.channelId)
  await navigateTo({ path: `/workshop/w/${ws.id}`, query: { view: 'chat' } })
}

async function markAll(): Promise<void> {
  try {
    await notifications.markRead({ all: true })
  }
  catch (e) {
    message.error(e instanceof Error ? e.message : '标记已读失败')
  }
}
</script>

<template>
  <a-dropdown
    v-model:open="open"
    placement="bottomRight"
    :trigger="['click']"
  >
    <button
      class="icon-btn nc-bell"
      :class="{ unread: notifications.unreadCount > 0 }"
      title="我的通知(@ 提及 / Agent 回复 / 审批)"
    >
      <span class="i-tabler-bell" />
      <span
        v-if="notifications.unreadCount > 0"
        class="nc-count"
      >{{ badge }}</span>
    </button>
    <template #overlay>
      <div class="nc-menu">
        <div class="nc-menu-title">
          <span>我的通知</span>
          <span class="nc-unread">{{ notifications.unreadCount }} 未读</span>
          <button
            v-if="notifications.unreadCount > 0"
            type="button"
            class="nc-markall"
            @click.stop="markAll"
          >
            全部已读
          </button>
        </div>
        <div class="nc-list">
          <button
            v-for="n in notifications.items"
            :key="n.id"
            type="button"
            class="nc-item"
            :class="{ unread: !n.readAt }"
            @click="openNotification(n)"
          >
            <span
              class="nc-item-icon"
              :class="[TYPE_META[n.type]?.icon, TYPE_META[n.type]?.tone]"
            />
            <span class="nc-item-body">
              <span class="nc-item-top">
                <span class="nc-item-type">{{ TYPE_META[n.type]?.label ?? n.type }}</span>
                <span class="nc-item-time">{{ formatLocalClock(n.createdAt, false) }}</span>
              </span>
              <span class="nc-item-title">{{ n.title }}</span>
              <span
                v-if="n.body"
                class="nc-item-text"
              >{{ n.body }}</span>
            </span>
            <span
              v-if="!n.readAt"
              class="nc-dot"
              aria-hidden="true"
            />
          </button>
          <div
            v-if="notifications.items.length === 0"
            class="nc-empty"
          >
            暂无通知 —— 被 @ 、收到 Agent 回复或审批请求时会出现在这里
          </div>
        </div>
      </div>
    </template>
  </a-dropdown>
</template>

<style scoped>
.nc-bell {
  position: relative;
  color: var(--ink-soft);
}
.nc-bell.unread { color: var(--tone-info-dot, #3b82f6); }
.nc-count {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
  line-height: 15px;
  color: var(--on-accent, #fff);
  text-align: center;
  background: var(--tone-info-dot, #3b82f6);
  border-radius: 8px;
}

.nc-menu {
  width: 320px;
  max-width: 86vw;
  padding: 6px;
  background: var(--paper, #fff);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm, 10px);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.14);
}
.nc-menu-title {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--line);
}
.nc-unread {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--ink-soft);
}
.nc-markall {
  margin-left: auto;
  font-size: 11px;
  color: var(--tone-info-dot, #3b82f6);
  cursor: pointer;
  background: transparent;
  border: 0;
}
.nc-list {
  max-height: 380px;
  overflow-y: auto;
}
.nc-item {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  width: 100%;
  margin-top: 4px;
  padding: 7px 8px;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-panel-sm, 8px);
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.nc-item:hover {
  background: var(--paper-deep);
  border-color: var(--line);
}
.nc-item.unread { background: color-mix(in srgb, var(--tone-info-dot, #3b82f6) 6%, transparent); }
.nc-item-icon {
  flex: none;
  margin-top: 2px;
  font-size: 14px;
  color: var(--ink-faint);
}
.nc-item-icon.mention { color: var(--mention-ink, var(--ink)); }
.nc-item-icon.reply { color: var(--tone-info-dot, #3b82f6); }
.nc-item-icon.hitl { color: var(--tone-warning-dot, #d4a017); }
.nc-item-icon.ok { color: var(--tone-success-dot); }
.nc-item-body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.nc-item-top {
  display: flex;
  gap: 6px;
  align-items: baseline;
  justify-content: space-between;
}
.nc-item-type {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
}
.nc-item-time {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--ink-fainter);
}
.nc-item-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  overflow-wrap: anywhere;
}
.nc-item-text {
  display: -webkit-box;
  overflow: hidden;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-soft);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}
.nc-dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-top: 5px;
  background: var(--tone-info-dot, #3b82f6);
  border-radius: 50%;
}
.nc-empty {
  padding: 18px 10px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--ink-faint);
  text-align: center;
}
</style>
