<script setup lang="ts">
/**
 * Composer 底部工具行:模式段控(群聊/任务/消息)、HITL 目标选择、
 * 任务模式参数(goal/loop/pipeline + 间隔/次数)、消息优先级与回执开关、发送钮。
 * 所有可写状态用 defineModel 双向绑定,状态仍由 Composer.vue 唯一持有。
 */
import type { ChatPermissions } from '@/app/stores/workshop/chat'
import type { AgentView } from '@/app/stores/workshop/entities'
import type { ComposerMode } from '@/app/composables/workshop/useComposerMentions'

defineProps<{
  canPost: boolean
  canManage: boolean
  /** null = 能力未知(尚未加载);界面对未知与无权限的渲染不同 */
  perms: ChatPermissions | null
  workersAndLead: AgentView[]
  sendLoading: boolean
  input: string
}>()

const emit = defineEmits<{
  (e: 'pick', mode: ComposerMode): void
  (e: 'send'): void
}>()

const mode = defineModel<ComposerMode>('mode', { required: true })
const toAgentId = defineModel<string>('toAgentId', { required: true })
const taskMode = defineModel<'goal' | 'loop' | 'pipeline'>('taskMode', { required: true })
const loopIntervalModel = defineModel<number | undefined>('loopIntervalModel', { required: true })
const loopMaxIterationsModel = defineModel<number | undefined>('loopMaxIterationsModel', { required: true })
const priority = defineModel<'task' | 'immediate'>('priority', { required: true })
const requireReply = defineModel<boolean>('requireReply', { required: true })
</script>

<template>
  <div class="composer-bar">
    <div class="cb-left">
      <div class="aw-seg">
        <!-- 群聊入口只在真的能发言时提供(否则是死按钮) -->
        <button
          v-if="canPost || !perms"
          type="button"
          :class="{ on: mode === 'chat' }"
          title="群聊:仅显式 @Agent 才触发执行"
          @click="emit('pick', 'chat')"
        >
          群聊
        </button>
        <button
          v-if="canManage || !perms || !canPost"
          type="button"
          :class="{ on: mode === 'task' }"
          @click="emit('pick', 'task')"
        >
          {{ $t('composer.k3wcox005') }}
        </button>
        <button
          v-if="canManage || !perms || !canPost"
          type="button"
          :class="{ on: mode === 'message' }"
          @click="emit('pick', 'message')"
        >
          {{ $t('composer.k41ykc007') }}
        </button>
      </div>

      <!-- HITL 目标选择(仅直发模式:群聊模式的路由由文本 @ 决定,没有"默认目标") -->
      <a-select
        v-if="mode !== 'chat'"
        v-model:value="toAgentId"
        size="small"
        class="target"
        :options="workersAndLead.map(a => ({ value: a.agentId, label: `@ ${a.name}${a.role === 'lead' ? ' · lead' : ''}` }))"
      />

      <template v-if="mode === 'task'">
        <div class="aw-seg">
          <button
            v-for="m in ['goal', 'loop', 'pipeline'] as const"
            :key="m"
            type="button"
            :class="{ on: taskMode === m }"
            @click="taskMode = m"
          >
            {{ m }}
          </button>
        </div>
        <template v-if="taskMode === 'loop'">
          <a-input-number
            v-model:value="loopIntervalModel"
            size="small"
            :min="1"
            :max="86400"
            :step="1"
            :precision="0"
            :addon-after="$t('composer.seconds')"
            class="loop-number"
          />
          <a-input-number
            v-model:value="loopMaxIterationsModel"
            size="small"
            :min="1"
            :max="10000"
            :step="1"
            :precision="0"
            :placeholder="$t('composer.k1b38y2b001')"
            class="loop-number iterations"
          />
        </template>
      </template>
      <template v-else-if="mode === 'message'">
        <div class="aw-seg">
          <button
            type="button"
            :class="{ on: priority === 'immediate' }"
            :title="$t('composer.k1jqqvhe002')"
            @click="priority = 'immediate'"
          >
            {{ $t('composer.k3x9n2008') }}
          </button>
          <button
            type="button"
            :class="{ on: priority === 'task' }"
            @click="priority = 'task'"
          >
            {{ $t('composer.k40g8m009') }}
          </button>
        </div>
        <button
          type="button"
          class="chip-toggle"
          :class="{ on: requireReply }"
          :title="$t('composer.k195594v003')"
          @click="requireReply = !requireReply"
        >
          <span class="i-tabler-mail-forward" />
          {{ $t('composer.k3xv7u010') }}
        </button>
      </template>
    </div>

    <div class="cb-right">
      <button
        type="button"
        class="send-btn im"
        :disabled="sendLoading || !input.trim() || (mode === 'chat' && !canPost)"
        :title="$t('composer.sendTitle')"
        @click="emit('send')"
      >
        <span class="i-tabler-send im-nudge-up" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 30px;
  margin-top: 6px;
}
.cb-left {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.cb-right {
  display: flex;
  flex: none;
  gap: 8px;
  align-items: center;
}

/* 回执切换 chip */
.chip-toggle {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 3px 10px;
  font-family: var(--font-body);
  font-size: 12px;
  color: var(--ink-faint);
  cursor: pointer;
  background: var(--paper-raised);
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-pill);
  transition: color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast);
}
.chip-toggle:hover { color: var(--ink); }
.chip-toggle.on {
  font-weight: 600;
  color: var(--ink);
  background: var(--paper-deep);
  border-color: var(--ink);
}

/* 发送:墨色药丸圆钮 */
.send-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 15px;
  color: var(--on-accent);
  cursor: pointer;
  background: var(--accent);
  border: 0;
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast), transform var(--transition-fast), opacity var(--transition-fast);
}
.send-btn:hover:not(:disabled) { background: var(--accent-strong); }
.send-btn:active:not(:disabled) { transform: scale(0.96); }
.send-btn:disabled { opacity: 0.3; cursor: default; }

.loop-number { width: 104px; }
.loop-number.iterations { width: 104px; }
.target { width: 138px; }

/* 窄屏覆盖(≤1023.98px):原 Composer.vue 同段规则按选择器归属拆分到此 */
@media (max-width: 1023.98px) {
  .composer-bar {
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 8px;
  }

  .cb-left {
    flex: 1 1 100%;
    row-gap: 8px;
  }

  .cb-right {
    flex: 1 1 100%;
  }

  /* 主操作:整行墨色药丸(触摸目标 44px) */
  .send-btn {
    width: 100%;
    height: 44px;
    font-size: 18px;
  }

  .aw-seg button {
    min-height: 40px;
    padding: 0 12px;
  }

  .chip-toggle {
    min-height: 40px;
  }

  .target {
    flex: 1 1 130px;
    width: auto;
  }

  .composer-bar :deep(.ant-select-selector) {
    min-height: 40px;
    align-items: center;
  }

  .loop-number,
  .loop-number.iterations {
    flex: 1 1 96px;
    width: auto;
  }

  .composer-bar :deep(.ant-input-number) {
    min-height: 40px;
  }
}
</style>
