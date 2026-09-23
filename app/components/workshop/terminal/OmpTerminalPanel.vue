<script setup lang="ts">
/**
 * OmpTerminalPanel —— omp harness 原生终端面板(依赖 DOM/xterm,浏览器端动态加载)。
 *
 * 数据面:WS /api/system/monitor/terminal/ws?pid&token(#shared/terminal-protocol)
 *  - 服务端 terminal-hub 镜像 omp `--mode rpc-ui` 子进程的全部 RPC 帧;
 *  - 本组件把结构化帧流渲染成 xterm TUI(user 回显 / assistant 流式 / thinking /
 *    工具执行 / host tool / HITL 对话框),还原"原生终端输出"体验;
 *  - 控制面(真 Human-in-the-loop):行内输入 → input(steer·follow_up 注入 omp
 *    会话);Ctrl+C / 中止按钮 → abort;HITL 面板 → ui_response(select·confirm·
 *    input·editor 对话框应答,直写 extension_ui_response)。
 *  - 断线自动重连(指数退避);重连全量重放按 seq 去重,时间线无缝续接。
 *
 * SSR 安全:xterm(CJS 包)在抽屉打开时动态 import(ensureTerm 内 await),
 * 服务端渲染路径零执行;xterm 样式经 nuxt.config css 全局注入。
 */
import TerminalHitlCard from '@/app/components/workshop/terminal/TerminalHitlCard.vue'
import { useOmpTerminalSession } from '@/app/composables/workshop/useOmpTerminalSession'

const props = defineProps<{
  /** pid 直连寻址(monitor 进程表) */
  pid?: number | null
  /** agent 寻址(lanes):解析该成员当前存活的 omp 进程,重启后自动落到新会话 */
  agentId?: string | null
  channelId?: string | null
  /** 抽屉标题附加信息(monitor 行/lane 头快照) */
  subtitle?: string
}>()
const open = defineModel<boolean>('open', { default: false })

const { t } = useI18n()

const {
  hostEl,
  connState,
  running,
  streaming,
  hitl,
  livePid,
  stateLabel,
  connLabel,
  hitlRespond,
  doAbort,
  doClear,
} = useOmpTerminalSession(props, open)
</script>

<template>
  <a-drawer
    v-model:open="open"
    placement="right"
    :width="860"
    :body-style="{ padding: '0', display: 'flex', flexDirection: 'column', background: '#10151c' }"
    :header-style="{ background: '#10151c', borderBottom: '1px solid #1d2733' }"
    class="omp-terminal-drawer"
  >
    <template #title>
      <div class="term-title">
        <span class="term-brand">
          <span class="i-tabler-terminal-2" />
        </span>
        <span class="term-name">{{ t('terminal.title') }}</span>
        <span class="ts-chip aw-mono ts-pid">PID {{ livePid ?? pid ?? '–' }}</span>
        <span
          v-if="subtitle"
          class="ts-chip ts-sub"
        >{{ subtitle }}</span>
      </div>
    </template>
    <template #extra>
      <div class="term-toolbar">
        <!-- 连接态 chip:呼吸点 + 文本(open=绿 / retrying=琥珀脉冲 / 其他=灰蓝) -->
        <span
          class="ts-chip aw-mono"
          :data-state="connState"
        ><span class="ts-dot" />{{ connLabel.text }}</span>
        <!-- 会话态 chip:idle=青 / busy=琥珀 / 流式=青脉冲 -->
        <span
          class="ts-chip aw-mono"
          :data-live="running ? (streaming ? 'streaming' : 'running') : 'idle'"
        >{{ stateLabel.text }}</span>
        <a-button
          size="small"
          danger
          class="ts-btn"
          :disabled="!running && !streaming"
          @click="doAbort"
        >
          <template #icon>
            <span class="i-tabler-player-stop" />
          </template>
          {{ t('terminal.abort') }}
        </a-button>
        <a-button
          size="small"
          class="ts-btn"
          @click="doClear"
        >
          <template #icon>
            <span class="i-tabler-eraser" />
          </template>
          {{ t('terminal.clear') }}
        </a-button>
      </div>
    </template>

    <div class="term-body">
      <!-- HITL 对话框(omp extension_ui_request;answer → ui_response) -->
      <TerminalHitlCard
        v-if="hitl"
        :hitl="hitl"
        @respond="hitlRespond"
      />

      <!-- xterm 终端 -->
      <div
        ref="hostEl"
        class="term-host"
      />

      <div class="term-hint aw-kicker">
        {{ t('terminal.hint') }}
      </div>
    </div>
  </a-drawer>
</template>

<style scoped>
/* 状态栏品牌块:终端图标入方形墨章(与侧栏墨方印同族,tokyo-night 冷暖对撞) */
.term-title {
  display: inline-flex;
  gap: 10px;
  align-items: center;
}
.term-brand {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  font-size: 14px;
  color: #9ece6a;
  background: rgb(158 206 106 / 10%);
  border: 1px solid rgb(158 206 106 / 22%);
  border-radius: var(--radius-panel-sm);
}
.term-name {
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: #e6edf3;
}

/* 状态 chip:等宽微字 + 语义点;色板对齐 xterm tokyo-night */
.ts-chip {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  padding: 1px 8px;
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: #a9b1d6;
  background: rgb(65 72 104 / 26%);
  border: 1px solid rgb(146 153 179 / 16%);
  border-radius: var(--radius-pill);
}
.ts-chip.ts-pid { color: #7dcfff; }
.ts-chip.ts-sub {
  font-family: var(--font-body);
  color: #9aa5ce;
}
.ts-dot {
  width: 6px;
  height: 6px;
  background: #565f89;
  border-radius: 50%;
}
/* 连接态语义色 */
.ts-chip[data-state='open'] { color: #9ece6a; background: rgb(158 206 106 / 10%); border-color: rgb(158 206 106 / 22%); }
.ts-chip[data-state='open'] .ts-dot { background: #9ece6a; animation: ts-breathe 2.2s ease-in-out infinite; }
.ts-chip[data-state='retrying'] { color: #e0af68; background: rgb(224 175 104 / 10%); border-color: rgb(224 175 104 / 24%); }
.ts-chip[data-state='retrying'] .ts-dot { background: #e0af68; animation: ts-breathe 1.1s ease-in-out infinite; }
.ts-chip[data-state='connecting'] { color: #7aa2f7; }
.ts-chip[data-state='connecting'] .ts-dot { background: #7aa2f7; animation: ts-breathe 1.1s ease-in-out infinite; }
/* 会话态 */
.ts-chip[data-live='streaming'] { color: #7dcfff; background: rgb(125 207 255 / 10%); border-color: rgb(125 207 255 / 24%); }
.ts-chip[data-live='streaming']::before {
  content: "";
  width: 6px;
  height: 6px;
  background: #7dcfff;
  border-radius: 50%;
  animation: ts-breathe 0.9s ease-in-out infinite;
}
.ts-chip[data-live='running'] { color: #e0af68; background: rgb(224 175 104 / 10%); border-color: rgb(224 175 104 / 24%); }
.ts-chip[data-live='running']::before {
  content: "";
  width: 6px;
  height: 6px;
  background: #e0af68;
  border-radius: 50%;
  animation: ts-breathe 1.6s ease-in-out infinite;
}
.ts-chip[data-live='idle'] { color: #565f89; }
.ts-chip[data-live='idle']::before {
  content: "";
  width: 6px;
  height: 6px;
  background: #565f89;
  border-radius: 50%;
}
@keyframes ts-breathe {
  0%, 100% { opacity: 0.45; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .ts-dot, .ts-chip::before { animation: none !important; opacity: 0.85; }
}

/* 工具按钮:暗面浮起 + 按压反馈 */
.term-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
}
:deep(.ts-btn.ant-btn) {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  color: #c0caf5;
  background: rgb(65 72 104 / 30%);
  border: 1px solid rgb(146 153 179 / 18%);
  transition: background 0.15s ease, transform 0.12s ease;
}
:deep(.ts-btn.ant-btn:hover:not(:disabled)) { background: rgb(65 72 104 / 50%); }
:deep(.ts-btn.ant-btn:active:not(:disabled)) { transform: translateY(1px); }
:deep(.ts-btn.ant-btn:disabled) { opacity: 0.4; }

.term-body {
  position: relative;
  display: flex;
  flex: 1;
  min-height: 0;
  flex-direction: column;
}

.term-host {
  flex: 1;
  min-height: 0;
  padding: 10px 12px 4px;
}

.term-hint {
  padding: 6px 12px 8px;
  color: rgb(214 222 232 / 45%);
  background: #10151c;
}
</style>

<style>
/* drawer 挂 body teleport,全局态:暗色标题/内容(xterm 主题一致) */
.omp-terminal-drawer .ant-drawer-header {
  background: linear-gradient(180deg, #131a24 0%, #10151c 100%) !important;
  border-bottom: 1px solid #1d2733 !important;
  box-shadow: inset 0 1px 0 rgb(146 153 179 / 6%);
}
.omp-terminal-drawer .ant-drawer-header-title {
  color: #e6edf3;
}
</style>
