<script setup lang="ts">
/**
 * 状态行 chip:说明当前模式(群聊/任务/消息)与参数、@提及将触发几次执行、
 * 目标成员与 HITL 可达性提示。纯展示,无状态、无事件。
 */
import type { AepChatMention } from '#shared/workshop-protocol'
import type { ComposerMode } from '@/app/composables/workshop/useComposerMentions'

defineProps<{
  mode: ComposerMode
  draftAgentMentions: AepChatMention[]
  draftUserMentions: AepChatMention[]
  taskMode: 'goal' | 'loop' | 'pipeline'
  loopIntervalSeconds: number | null
  targetName: string
  isDefaultLead: boolean
  reachHint: { tone: 'ok' | 'info' | 'warn', text: string, title: string } | null
  priority: 'task' | 'immediate'
}>()
</script>

<template>
  <div class="composer-status-chip">
    <template v-if="mode === 'chat'">
      <span class="chip-key">群聊</span>
      <span
        v-if="draftAgentMentions.length > 0"
        class="reach-chip"
        data-tone="info"
        :title="'仅显式 @Agent 触发执行'"
      >
        <span
          class="reach-dot"
          aria-hidden="true"
        />@{{ draftAgentMentions.map(m => m.label).join(' @') }} · 将触发 {{ draftAgentMentions.length }} 次 Agent 执行
      </span>
      <span
        v-else
        class="reach-chip"
        data-tone="ok"
        title="未 @Agent:消息只进群聊,不触发任何 Agent"
      >
        <span
          class="reach-dot"
          aria-hidden="true"
        />仅群聊 · 0 次 Agent 执行
      </span>
      <span
        v-if="draftUserMentions.length > 0"
        class="chip-hint"
      >@{{ draftUserMentions.map(m => m.label).join(' @') }} 将收到定向通知</span>
      <span
        v-else
        class="chip-hint"
      >输入 @ 提及成员 · Enter 发送</span>
    </template>
    <template v-else-if="mode === 'task'">
      <span class="chip-key">{{ $t('composer.k3wcox005') }}</span>
      <span>{{ taskMode }}</span>
      <span v-if="taskMode === 'loop'">
        {{ $t('composer.k49kr1011') }} {{ loopIntervalSeconds ?? '-' }}s
      </span>
      <span
        class="chip-target"
        :title="isDefaultLead ? $t('composer.defaultLeadTitle') : $t('composer.kl3604i033', { p0: targetName })"
      >→ {{ targetName ? `@${targetName}` : 'lead' }}{{ isDefaultLead ? $t('composer.k2z7yuw012') : $t('composer.k2z0fsx032') }}</span>
      <!-- HITL 送达语义提示 -->
      <span
        v-if="reachHint"
        class="reach-chip"
        :data-tone="reachHint.tone"
        :title="reachHint.title"
      >
        <span
          class="reach-dot"
          aria-hidden="true"
        />{{ reachHint.text }}
      </span>
      <span class="chip-hint">{{ $t('composer.k17u6q77006') }}</span>
    </template>
    <template v-else>
      <span class="chip-key">{{ $t('composer.k41ykc007') }}</span>
      <span v-if="targetName">@{{ targetName }}{{ isDefaultLead ? $t('composer.k2z7yuw012') : '' }}</span>
      <span>{{ priority === 'immediate' ? $t('composer.k1bosqfv013') : $t('composer.k40g8m009') }}</span>
      <!-- 可达性提示(open-tag reach hint):对方能否收到、将以何种方式送达 -->
      <span
        v-if="reachHint"
        class="reach-chip"
        :data-tone="reachHint.tone"
        :title="reachHint.title"
      >
        <span
          class="reach-dot"
          aria-hidden="true"
        />{{ reachHint.text }}
      </span>
      <span class="chip-hint">{{ $t('composer.chipHint') }}</span>
    </template>
  </div>
</template>

<style scoped>
/* 状态行:轻 chip 说明当前模式参数 */
.composer-status-chip {
  display: flex;
  gap: 6px;
  align-items: center;
  width: max-content;
  max-width: 100%;
  margin: 0 0 4px 2px;
  padding: 2px 8px;
  font-size: 11.5px;
  color: var(--ink-faint);
  background: var(--paper-deep);
  border-radius: var(--radius-chip);
}
.chip-key {
  font-weight: 600;
  color: var(--ink-soft);
}
.chip-target {
  font-weight: 600;
  color: var(--ink);
}
.chip-hint {
  margin-left: auto;
  padding-left: 8px;
  color: var(--ink-faint);
}

/* 可达性提示 chip:ok 绿 / info 蓝 / warn 琥珀 —— 状态不只靠颜色(附文字) */
.reach-chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  padding: 0 6px;
  font-size: 10.5px;
  border-radius: var(--radius-chip);
}
.reach-chip .reach-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}
.reach-chip[data-tone='ok'] { color: var(--tone-success-dot); background: color-mix(in srgb, var(--tone-success-dot) 10%, transparent); }
.reach-chip[data-tone='info'] { color: var(--tone-info-dot); background: color-mix(in srgb, var(--tone-info-dot) 10%, transparent); }
.reach-chip[data-tone='warn'] { color: var(--tone-warning-dot); background: color-mix(in srgb, var(--tone-warning-dot) 13%, transparent); }

/* 窄屏覆盖(≤1023.98px):原 Composer.vue 同段规则按选择器归属拆分到此 */
@media (max-width: 1023.98px) {
  /* 状态 chip:桌面宽度自适应内容,窄屏必须允许折行,否则顶破输入卡 */
  .composer-status-chip {
    width: auto;
    flex-wrap: wrap;
    row-gap: 2px;
    font-size: 11.5px;
    line-height: 1.45;
  }

  .chip-hint {
    flex: 1 1 100%;
    padding-left: 0;
    margin-left: 0;
  }

  .reach-chip {
    font-size: 11.5px;
  }
}
</style>
