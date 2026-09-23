<script setup lang="ts">
/**
 * 小镇视图 · 右轨检查器 · 角色工业节点绑定段(控制模式 + 手动确认审批)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { useDaqStream } from '@/app/composables/workshop/useDaqStream'
import type { useDcwStream } from '@/app/composables/workshop/useDcwStream'
import type { AgentNodeBindingRow, ToolApprovalRow } from '@/app/composables/workshop/town/town-view-types'

const agentBindKind = defineModel<'dcw' | 'daq'>('agentBindKind', { required: true })
const agentBindNodeId = defineModel<string>('agentBindNodeId', { required: true })
const agentBindMode = defineModel<'auto' | 'manual'>('agentBindMode', { required: true })
const approvalComments = defineModel<Record<string, string>>('approvalComments', { required: true })

defineProps<{
  mode: 'browse' | 'edit'
  agentBindings: AgentNodeBindingRow[]
  pendingApprovals: ToolApprovalRow[]
  approvalRemainingSec: (ap: ToolApprovalRow) => number
  bindingNodeName: (b: AgentNodeBindingRow) => string
  setBindingMode: (id: string, mode: 'auto' | 'manual') => void
  unbindAgentNode: (id: string) => void
  bindAgentNode: () => void
  decideApproval: (id: string, approved: boolean) => void
  daq: ReturnType<typeof useDaqStream>
  dcw: ReturnType<typeof useDcwStream>
}>()
</script>

<template>
  <!-- 工业节点绑定(数采/数控工具授权 + 控制模式 + 手动确认审批) -->
  <div class="obj-sep" />
  <div class="sect-hd">
    {{ $t('townView.k1p7nru2094') }}
  </div>
  <div
    v-for="b in agentBindings"
    :key="b.id"
    class="bind-row"
  >
    <span
      class="ins-chip"
      :class="b.kind === 'dcw' ? 'accent' : ''"
      style="flex: none;"
    >{{ b.kind === 'dcw' ? $t('townView.k40ifw097') : $t('townView.k40rjw098') }}</span>
    <span class="bind-meta">
      <span class="bind-label">{{ bindingNodeName(b) }}</span>
      <select
        class="bind-select"
        style="margin-top: 3px;"
        :value="b.mode"
        :title="$t('townView.khqvwix019')"
        @change="setBindingMode(b.id, ($event.target as HTMLSelectElement).value as 'auto' | 'manual')"
      >
        <option value="auto">
          {{ $t('townView.k1io1ylm095') }}
        </option>
        <option value="manual">
          {{ $t('townView.k1duyr8q096') }}
        </option>
      </select>
    </span>
    <button
      class="bind-x"
      :title="$t('townView.k1k73omv016')"
      @click="unbindAgentNode(b.id)"
    >
      ✕
    </button>
  </div>
  <div
    v-if="!agentBindings.length"
    class="ins-empty"
  >
    {{ $t('townView.unboundTip') }}
  </div>
  <div
    v-if="mode === 'edit'"
    class="daq-bind-bar"
    style="margin-bottom: 8px;"
  >
    <select
      v-model="agentBindKind"
      class="bind-select"
      style="flex: none; width: 62px;"
    >
      <option value="dcw">
        {{ $t('townView.k40ifw097') }}
      </option>
      <option value="daq">
        {{ $t('townView.k40rjw098') }}
      </option>
    </select>
    <select
      v-model="agentBindNodeId"
      class="bind-select"
    >
      <option value="">
        {{ $t('townView.kurjldk099') }}
      </option>
      <template v-if="agentBindKind === 'dcw'">
        <option
          v-for="n in dcw.nodes"
          :key="n.id"
          :value="n.id"
        >
          {{ n.name }}
        </option>
      </template>
      <template v-else>
        <option
          v-for="n in daq.nodes"
          :key="n.id"
          :value="n.id"
        >
          {{ n.name }}
        </option>
      </template>
    </select>
    <select
      v-model="agentBindMode"
      class="bind-select"
      style="flex: none; width: 76px;"
    >
      <option value="auto">
        {{ $t('townView.k45kpj100') }}
      </option>
      <option value="manual">
        {{ $t('townView.k3zul4101') }}
      </option>
    </select>
    <button
      class="bind-add-btn"
      :disabled="!agentBindNodeId"
      @click="bindAgentNode"
    >
      {{ $t('townView.k452a8102') }}
    </button>
  </div>

  <!-- 手动确认:待审批 -->
  <template v-if="pendingApprovals.length">
    <div
      class="sect-hd"
      style="color: var(--hud-amber);"
    >
      {{ $t('townView.k1gk2jg7132') }} {{ pendingApprovals.length }}
    </div>
    <div
      v-for="ap in pendingApprovals"
      :key="ap.id"
      class="approval-card"
    >
      <div class="approval-detail">
        {{ ap.detail }}
      </div>
      <div
        class="approval-ttl"
        :class="{ urgent: approvalRemainingSec(ap) <= 30 }"
      >
        ⏱ {{ approvalRemainingSec(ap) }}s {{ $t('townView.hitlAutoReject') }}
      </div>
      <input
        v-model="approvalComments[ap.id]"
        class="dcw-write input-inline"
        style="width: 100%; margin-top: 5px;"
        :placeholder="$t('townView.keztqrn020')"
      >
      <div
        class="daq-bind-bar"
        style="margin-top: 5px;"
      >
        <button
          class="bind-add-btn"
          @click="decideApproval(ap.id, true)"
        >
          {{ $t('townView.kslcozu103') }}
        </button>
        <button
          class="bind-add-btn danger"
          @click="decideApproval(ap.id, false)"
        >
          {{ $t('townView.k14gu3rd104') }}
        </button>
      </div>
    </div>
  </template>
</template>

<style scoped>
.ins-chip-row { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
.ins-chip {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-dim);
  border: 1px solid #26354a;
  border-radius: 6px;
  padding: 1.5px 7px;
}
.ins-chip.accent { color: var(--hud-accent); border-color: rgba(53, 224, 160, 0.4); }
.sect-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--hud-faint);
  letter-spacing: 0.16em;
  font-weight: 700;
  margin: 10px 0 7px;
}
/* 分区头刻度线:与面板左缘数据条同 motif,建立分区节奏 */
.sect-hd::before {
  content: '';
  width: 3px;
  height: 9px;
  background: var(--hud-accent);
  border-radius: 1px;
  opacity: 0.55;
}
.obj-sep { height: 1px; background: var(--hud-line-soft); margin: 8px 0; }
.ins-empty { color: var(--hud-faint); font-size: 11px; text-align: center; padding: 8px 0 6px; }
.bind-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 7px 9px;
  margin-bottom: 6px;
  background: #0f1726;
  border: 1px solid var(--hud-line-soft);
  border-radius: var(--hud-r-md);
}
.bind-ico {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--hud-accent);
  background: #0d1a26;
  border-radius: 7px;
}
.bind-svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.bind-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.bind-label { font-size: 11px; font-weight: 600; color: var(--hud-text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bind-val { font-family: var(--font-mono); font-size: 10px; color: var(--hud-cyan); font-variant-numeric: tabular-nums; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bind-val b { font-size: 11px; font-weight: 700; }
.bind-spark { width: 56px; height: 20px; flex: none; }
.bind-x {
  flex: none;
  width: 22px;
  height: 22px;
  color: var(--hud-faint);
  background: transparent;
  border: 0;
  border-radius: 6px;
  cursor: pointer;
}
.bind-x:hover { background: rgba(255, 107, 107, 0.12); color: var(--hud-danger); }
.dcw-write { display: flex; gap: 6px; }
.dcw-write input {
  flex: 1;
  min-width: 0;
  height: 27px;
  padding: 0 9px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--hud-text);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: 7px;
  transition: border-color 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease);
}
.dcw-write input::placeholder { color: var(--hud-faint); font-size: 10px; }
.dcw-write input:focus {
  outline: none;
  border-color: var(--hud-accent);
  box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.13);
}
/* 绑定行 hover 微抬(DAQ 行与智控卡同一 hover 语言) */
.bind-row { transition: border-color 0.18s var(--hud-ease), box-shadow 0.18s var(--hud-ease); }
.bind-row:hover {
  border-color: var(--hud-line-hi);
  box-shadow: 0 6px 18px rgba(3, 7, 14, 0.4);
}
/* 添加通道按钮:虚线框 hover 实心化 + 底色微亮 */
.bind-add:hover { background: rgba(53, 224, 160, 0.05); border-style: solid; }
.daq-bind-bar { display: flex; gap: 6px; }
.bind-select {
  flex: 1;
  min-width: 0;
  height: 28px;
  font-size: 10.5px;
  color: var(--hud-dim);
  background: var(--hud-input);
  border: 1px solid var(--hud-line);
  border-radius: var(--hud-r-sm);
  padding: 0 8px;
  transition: border-color 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease), color 0.15s var(--hud-ease);
}
.bind-select:hover { border-color: var(--hud-line-hi); color: var(--hud-text); }
.bind-select:focus { outline: none; border-color: var(--hud-accent); color: var(--hud-text); box-shadow: 0 0 0 3px rgba(53, 224, 160, 0.13); }
.bind-add-btn {
  flex: none;
  height: 28px;
  padding: 0 12px;
  font-size: 10.5px;
  font-weight: 600;
  color: #04120c;
  background: var(--hud-accent-dim);
  border: 0;
  border-radius: var(--hud-r-sm);
  cursor: pointer;
  transition: background 0.15s var(--hud-ease), box-shadow 0.15s var(--hud-ease);
}
.bind-add-btn:hover:not(:disabled) {
  background: var(--hud-accent);
  box-shadow: 0 0 14px rgba(53, 224, 160, 0.35);
}
.bind-add-btn:disabled { opacity: 0.4; cursor: default; }
.bind-add-btn.warn:not(:disabled) {
  color: var(--hud-amber);
  background: rgba(246, 196, 83, 0.12);
  box-shadow: none;
}
.bind-add-btn.warn:hover:not(:disabled) {
  background: rgba(246, 196, 83, 0.2);
  box-shadow: 0 0 14px rgba(246, 196, 83, 0.25);
}
.bind-add-btn.danger:not(:disabled) {
  color: var(--hud-danger);
  background: rgba(255, 107, 107, 0.1);
  box-shadow: none;
}
.bind-add-btn.danger:hover:not(:disabled) {
  background: rgba(255, 107, 107, 0.18);
  box-shadow: 0 0 14px rgba(255, 107, 107, 0.25);
}
.approval-card {
  padding: 8px 9px;
  margin-bottom: 7px;
  background: rgba(246, 196, 83, 0.06);
  border: 1px solid rgba(246, 196, 83, 0.3);
  border-radius: var(--hud-r-md);
}
.approval-detail { font-size: 11px; color: var(--hud-text); }
/* 超时默认拒绝倒计时:琥珀常态,≤30s 转警示红 */
.approval-ttl {
  margin-top: 5px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.05em;
  color: var(--hud-amber);
}
.approval-ttl.urgent { color: var(--hud-danger); }
/* 按压态:轻微下沉,松手回弹(自 TownView.vue 同源规则搬移) */
.bind-x:active, .bind-add:active {
  transform: scale(0.96);
}
bind-x, bind-add {
  transition-property: filter, background, border-color, color, transform, opacity;
  transition-duration: 0.15s;
  transition-timing-function: var(--hud-ease);
}
/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
.bind-select:focus-visible,
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--hud-bg), 0 0 0 4px rgba(65, 200, 244, 0.45);
  border-radius: 6px;
}
/* ── 触摸目标:窄屏所有可点元件 ≥40px 高(与 .town-view button 同效) ── */
@media (max-width: 1023px) {
  button { min-height: 40px; }
}
</style>
