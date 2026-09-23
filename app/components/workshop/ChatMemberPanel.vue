<script setup lang="ts">
/**
 * ChatMemberPanel —— 群成员名册 + 成员生命周期 + 群聊设置(v17 主计划 §4/§5)。
 *
 * 权限展示原则:**服务端是唯一事实源**,面板只按 `permissions` 渲染:
 *  - 非管理者(无 canManage)看不到任何"能管理"的控件 —— 不渲染死按钮(服务端另有硬校验);
 *  - 加入/退出由 canJoin / isMember 驱动;pending 状态显式提示"等待 owner 批准";
 *  - 设置块只在 canManage 时出现,且**必须带 version** 提交乐观锁:
 *    409 VERSION_CONFLICT 不是泛化错误,而是"别人刚改过,请刷新后重试"。
 */
import { message } from 'ant-design-vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useChatStore, chatErrorCode, chatErrorMessage, type ChatPermissions } from '@/app/stores/workshop/chat'
import { formatLocalClock } from '@/app/composables/workshop/useLocalTime'
import type { AepChannelMember } from '#shared/workshop-protocol'

const props = defineProps<{ channelId: string }>()

const chat = useChatStore()

const perms = computed<ChatPermissions | null>(() => chat.permissions[props.channelId] ?? null)
const members = computed<AepChannelMember[]>(() => chat.members[props.channelId] ?? [])
const settings = computed(() => chat.settings[props.channelId] ?? null)

const canManage = computed(() => perms.value?.canManage === true)
const isOwner = computed(() => perms.value?.isOwner === true)
const isMember = computed(() => perms.value?.isMember === true)
const canJoin = computed(() => perms.value?.canJoin === true)
const myStatus = computed(() => perms.value?.status ?? null)

/** active 优先,其次 pending,最后历史态(left/removed 保留可见性但弱化) */
const sortedMembers = computed(() => {
  const rank: Record<string, number> = { active: 0, pending: 1, left: 2, removed: 3 }
  return [...members.value].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))
})

const busy = ref<string | null>(null)
const settingsError = ref('')

/** 设置草稿(与已保存值分离;保存成功才回填) */
const draft = ref<{ visibility: 'private' | 'public', joinPolicy: 'open' | 'owner_approve', approvalPolicy: 'owner_only' | 'any_member', chatEnabled: boolean } | null>(null)

function syncDraft(): void {
  const s = settings.value
  if (!s) {
    draft.value = null
    return
  }
  draft.value = {
    visibility: s.visibility,
    joinPolicy: s.joinPolicy,
    approvalPolicy: s.approvalPolicy,
    chatEnabled: s.chatEnabled === 1,
  }
}

async function refresh(): Promise<void> {
  // 两个调用都在 store 内吞掉错误(权限视图失败会落地 null 态,名册对非成员 403 属正常路径)
  await chat.loadPermissions(props.channelId)
  await chat.loadMembers(props.channelId)
}

onMounted(() => {
  void refresh().then(syncDraft)
})
watch(() => props.channelId, () => {
  settingsError.value = ''
  void refresh().then(syncDraft)
})
// 服务端广播设置变更(chat.settings 帧)→ 未编辑时同步草稿
watch(settings, (s, prev) => {
  if (!s) return
  if (!prev || prev.version !== s.version) syncDraft()
})

async function onJoin(): Promise<void> {
  busy.value = 'join'
  try {
    const status = await chat.join(props.channelId)
    if (status === 'pending') message.info('已提交加入申请,等待 owner 批准')
    else message.success('已加入群聊')
    await refresh()
  }
  catch (e) {
    const code = chatErrorCode(e)
    if (code === 'CHAT_DISABLED') message.warning('该 Channel 未开启群聊')
    else if (code === 'CHANNEL_PRIVATE') message.warning('该 Channel 未公开,需 owner 邀请')
    else message.error(chatErrorMessage(e))
  }
  finally {
    busy.value = null
  }
}

async function onLeave(): Promise<void> {
  busy.value = 'leave'
  try {
    await chat.leave(props.channelId)
    message.success('已退出群聊')
    await refresh()
  }
  catch (e) {
    if (chatErrorCode(e) === 'OWNER_CANNOT_LEAVE') message.warning('owner 不能退出群聊,请先转移 owner')
    else message.error(chatErrorMessage(e))
  }
  finally {
    busy.value = null
  }
}

async function onApprove(m: AepChannelMember): Promise<void> {
  busy.value = `approve:${m.userId}`
  try {
    await chat.approveMember(props.channelId, m.userId)
    message.success('已批准加入')
  }
  catch (e) {
    message.error(chatErrorMessage(e))
  }
  finally {
    busy.value = null
  }
}

async function onRemove(m: AepChannelMember): Promise<void> {
  busy.value = `remove:${m.userId}`
  try {
    await chat.removeMember(props.channelId, m.userId)
    message.success('已移除成员')
  }
  catch (e) {
    message.error(chatErrorMessage(e))
  }
  finally {
    busy.value = null
  }
}

/**
 * 保存群聊设置(owner-only)。
 * 乐观锁:必须带上打开面板时的 version;409 = 期间被他人改过 → 引导刷新,不覆盖。
 */
async function onSaveSettings(): Promise<void> {
  const d = draft.value
  if (!d) return
  settingsError.value = ''
  busy.value = 'settings'
  try {
    await chat.updateSettings(props.channelId, {
      visibility: d.visibility,
      joinPolicy: d.joinPolicy,
      approvalPolicy: d.approvalPolicy,
      chatEnabled: d.chatEnabled ? 1 : 0,
    })
    message.success('群聊设置已保存')
    syncDraft()
  }
  catch (e) {
    if (chatErrorCode(e) === 'VERSION_CONFLICT') {
      settingsError.value = 'Channel 设置已被他人修改,请刷新后重试'
    }
    else if (chatErrorCode(e) === 'CHAT_DISABLED') {
      settingsError.value = chatErrorMessage(e)
    }
    else {
      settingsError.value = chatErrorMessage(e)
    }
  }
  finally {
    busy.value = null
  }
}

const statusLabel: Record<AepChannelMember['status'], string> = {
  active: '在群',
  pending: '待批准',
  left: '已退出',
  removed: '已移除',
}

const avatarText = (m: AepChannelMember): string =>
  (m.displayName || m.userId.slice(0, 8)).trim().charAt(0).toUpperCase()
</script>

<template>
  <div class="member-panel">
    <div class="mp-head">
      <span class="i-tabler-users-group mp-icon" />
      <span class="mp-title">成员</span>
      <span class="mp-count">{{ members.filter(m => m.status === 'active').length }}</span>
      <span class="mp-spacer" />
      <button
        type="button"
        class="mp-refresh"
        title="刷新成员与设置"
        @click="refresh().then(syncDraft)"
      >
        <span class="i-tabler-refresh" />
      </button>
    </div>

    <div class="mp-scroll">
      <!-- 加入 / 退出 / 待批准(由服务端能力视图驱动) -->
      <div class="mp-actions">
        <template v-if="!isMember">
          <a-button
            v-if="canJoin"
            size="small"
            type="primary"
            block
            :loading="busy === 'join'"
            @click="onJoin"
          >
            加入群聊
          </a-button>
          <div
            v-else
            class="mp-hint"
          >
            {{ perms === null ? '未加入群聊 —— 需 owner 邀请或 Channel 未公开' : '该 Channel 未公开或未开启群聊 —— 需 owner 邀请' }}
          </div>
        </template>
        <template v-else-if="myStatus === 'pending'">
          <div class="mp-hint pending">
            <span class="i-tabler-hourglass" /> 加入申请待 owner 批准
          </div>
        </template>
        <template v-else-if="!isOwner">
          <a-popconfirm
            title="退出群聊后将立即失去读、发言、审批与通知补拉权限,确认退出?"
            :ok-text="$t('common.confirm')"
            :cancel-text="$t('common.cancel')"
            @confirm="onLeave"
          >
            <a-button
              size="small"
              block
              :loading="busy === 'leave'"
            >
              退出群聊
            </a-button>
          </a-popconfirm>
        </template>
        <div
          v-else
          class="mp-hint"
        >
          <span class="i-tabler-crown" /> 你是 owner(不可退出,可转移 owner 或删除 Channel)
        </div>
      </div>

      <!-- 名册 -->
      <div class="mp-list">
        <div
          v-for="m in sortedMembers"
          :key="m.userId"
          class="mp-row"
          :class="m.status"
        >
          <span class="aw-avatar mp-ava">{{ avatarText(m) }}</span>
          <div class="mp-info">
            <div class="mp-name-line">
              <span class="mp-name">{{ m.displayName || m.userId.slice(0, 8) }}</span>
              <span
                v-if="m.role === 'owner'"
                class="mp-role owner"
              >owner</span>
            </div>
            <div class="mp-sub">
              <span
                class="mp-status"
                :data-status="m.status"
              >{{ statusLabel[m.status] }}</span>
              <span class="mp-joined">{{ formatLocalClock(m.joinedAt, false) }}</span>
            </div>
          </div>
          <!-- 管理动作:仅 canManage 出现(pending 批准 / 非 owner 移除) -->
          <div
            v-if="canManage && m.role !== 'owner'"
            class="mp-row-actions"
          >
            <a-button
              v-if="m.status === 'pending'"
              size="small"
              type="primary"
              :loading="busy === `approve:${m.userId}`"
              @click="onApprove(m)"
            >
              批准
            </a-button>
            <a-popconfirm
              v-if="m.status === 'active' || m.status === 'pending'"
              title="移除该成员后其立即失去群聊与审批权限,确认?"
              :ok-text="$t('common.remove')"
              :cancel-text="$t('common.cancel')"
              @confirm="onRemove(m)"
            >
              <a-button
                size="small"
                danger
                :loading="busy === `remove:${m.userId}`"
              >
                {{ $t('common.remove') }}
              </a-button>
            </a-popconfirm>
          </div>
        </div>
        <div
          v-if="sortedMembers.length === 0"
          class="mp-hint"
        >
          名册不可见(非成员)
        </div>
      </div>

      <!-- 群聊设置:只在 canManage 时渲染(非管理者看不到任何管理控件) -->
      <div
        v-if="canManage && draft"
        class="mp-settings"
      >
        <div class="mp-sec-title">
          群聊设置
          <span class="mp-ver">v{{ settings?.version ?? '-' }}</span>
        </div>
        <label class="mp-field">
          <span>可见性</span>
          <a-select
            v-model:value="draft.visibility"
            size="small"
            :options="[{ value: 'private', label: '私有(仅成员可见)' }, { value: 'public', label: '公开(登录用户可发现)' }]"
          />
        </label>
        <label class="mp-field">
          <span>加入策略</span>
          <a-select
            v-model:value="draft.joinPolicy"
            size="small"
            :options="[{ value: 'owner_approve', label: '需 owner 批准' }, { value: 'open', label: '开放加入' }]"
          />
        </label>
        <label class="mp-field">
          <span>审批策略</span>
          <a-select
            v-model:value="draft.approvalPolicy"
            size="small"
            :options="[{ value: 'owner_only', label: '仅 owner 可决策' }, { value: 'any_member', label: '任一成员可决策' }]"
          />
        </label>
        <label class="mp-field switch">
          <span>开启群聊</span>
          <a-switch
            v-model:checked="draft.chatEnabled"
            size="small"
          />
        </label>
        <div
          v-if="settingsError"
          class="mp-error"
        >
          {{ settingsError }}
          <a-button
            size="small"
            type="link"
            @click="refresh().then(syncDraft)"
          >
            刷新
          </a-button>
        </div>
        <a-button
          size="small"
          type="primary"
          block
          :loading="busy === 'settings'"
          @click="onSaveSettings"
        >
          保存设置
        </a-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.member-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--paper-raised);
}

.mp-head {
  display: flex;
  flex: none;
  gap: 7px;
  align-items: center;
  padding: 7px 12px;
  font-size: 12px;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--line);
}
.mp-icon { font-size: 14px; }
.mp-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
}
.mp-count {
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 10px;
  background: var(--paper-deep);
  border-radius: var(--radius-chip);
}
.mp-spacer { flex: 1 1 auto; }
.mp-refresh {
  display: inline-flex;
  align-items: center;
  padding: 2px 4px;
  font-size: 13px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
}
.mp-refresh:hover { color: var(--ink); }

.mp-scroll {
  flex: 1 1 auto;
  min-height: 0;
  padding: 8px 10px 10px;
  overflow-y: auto;
}

.mp-actions { margin-bottom: 8px; }
.mp-hint {
  display: flex;
  gap: 5px;
  align-items: center;
  padding: 5px 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border-radius: var(--radius-chip);
}
.mp-hint.pending { color: var(--tone-warning-dot); }
.mp-error {
  display: flex;
  gap: 4px;
  align-items: center;
  margin: 6px 0;
  padding: 5px 8px;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--tone-danger-dot);
  background: color-mix(in srgb, var(--tone-danger-dot) 8%, transparent);
  border-radius: var(--radius-chip);
}

.mp-list { display: flex; flex-direction: column; }
.mp-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 5px 6px;
  border-radius: var(--radius-panel-sm);
}
.mp-row:hover { background: var(--paper-deep); }
.mp-row.left,
.mp-row.removed { opacity: 0.55; }
.mp-ava {
  width: 24px;
  height: 24px;
  font-size: 11px;
}
.mp-info {
  flex: 1 1 auto;
  min-width: 0;
}
.mp-name-line {
  display: flex;
  gap: 5px;
  align-items: baseline;
  min-width: 0;
}
.mp-name {
  overflow: hidden;
  font-size: 12.5px;
  color: var(--ink);
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mp-role.owner {
  flex: none;
  padding: 0 5px;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.08em;
  color: var(--tone-warning-dot);
  border: 1px solid color-mix(in srgb, var(--tone-warning-dot) 40%, transparent);
  border-radius: var(--radius-chip);
}
.mp-sub {
  display: flex;
  gap: 6px;
  align-items: center;
  font-size: 10.5px;
  color: var(--ink-fainter);
}
.mp-status[data-status='active'] { color: var(--tone-success-dot); }
.mp-status[data-status='pending'] { color: var(--tone-warning-dot); }
.mp-status[data-status='removed'] { color: var(--tone-danger-dot); }
.mp-joined { font-family: var(--font-mono); }
.mp-row-actions {
  display: flex;
  flex: none;
  gap: 4px;
}

.mp-settings {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--line);
}
.mp-sec-title {
  display: flex;
  gap: 6px;
  align-items: baseline;
  margin-bottom: 6px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--ink-soft);
}
.mp-ver {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--ink-fainter);
}
.mp-field {
  display: flex;
  gap: 6px;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 5px;
  font-size: 11.5px;
  color: var(--ink-soft);
}
.mp-field :deep(.ant-select) { min-width: 132px; }
.mp-field.switch { margin-bottom: 8px; }
</style>
