<script setup lang="ts">
/**
 * 小镇视图 · 左轨智控目录(模板分组树 + 可拖节点叶子)
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import type { DcwNodeView } from '@/app/composables/workshop/useDcwStream'
import type { useDeviceTwins } from '@/app/composables/workshop/useDeviceTwins'
import type { DcwTemplate, RailLeafState } from '@/app/composables/workshop/town/town-view-types'

defineProps<{
  mode: 'browse' | 'edit'
  treeOpen: Record<string, boolean>
  dcwTemplates: DcwTemplate[]
  dcwNodesByTpl: Map<string, DcwNodeView[]>
  deviceTwins: ReturnType<typeof useDeviceTwins>
  dcwLeafState: (n: DcwNodeView) => RailLeafState
  toggleTreeGroup: (key: string) => void
  createDcwFromTemplate: (tpl: { id: string }) => void
  onDcwNodeDragStart: (e: DragEvent, n: DcwNodeView) => void
  onFocusDevice: (t: { id: string, posX?: number, posZ?: number }) => void
}>()
</script>

<template>
  <div class="daq-list">
    <div
      v-for="tpl in dcwTemplates"
      :key="tpl.id"
      class="daq-group"
    >
      <!-- 模板分组头:点击展开/收起;不可拖拽(模板不能实例化,节点才能) -->
      <div
        class="daq-card tpl"
        :class="{ open: !!treeOpen[`dcw:${tpl.id}`] }"
        role="button"
        tabindex="0"
        :title="$t('townView.k2tplxp0001', { p0: tpl.name, p1: tpl.ch, p2: tpl.min, p3: tpl.max, p4: tpl.unit })"
        @click="toggleTreeGroup(`dcw:${tpl.id}`)"
        @keydown.enter.prevent="toggleTreeGroup(`dcw:${tpl.id}`)"
      >
        <span class="daq-caret">▶</span>
        <span class="daq-ico">
          <WorkshopDaqTemplateIcon
            class="daq-svg"
            :icon="tpl.icon"
          />
        </span>
        <div class="daq-meta">
          <span class="daq-name">{{ tpl.name }}</span>
          <span class="daq-code">{{ tpl.code }}</span>
        </div>
        <button
          v-if="mode === 'edit'"
          class="daq-add"
          :title="$t('townView.k2tplxp0002', { p0: tpl.name })"
          @click.stop="createDcwFromTemplate(tpl)"
        >
          ＋
        </button>
        <span class="daq-count">×{{ dcwNodesByTpl.get(tpl.id)?.length ?? 0 }}</span>
      </div>
      <!-- 节点叶子:拖入场景落位;绑定设备后即可在设备面板直写下发 -->
      <div
        v-if="treeOpen[`dcw:${tpl.id}`]"
        class="daq-children"
      >
        <div
          v-for="n in dcwNodesByTpl.get(tpl.id) ?? []"
          :key="n.id"
          class="daq-node"
          :class="{ placed: typeof n.posX === 'number' }"
          :draggable="mode === 'edit'"
          :title="typeof n.posX === 'number' ? $t('townView.k2tplxp0005') : $t('townView.k2tplxp0006')"
          @dragstart="onDcwNodeDragStart($event, n)"
          @click="typeof n.posX === 'number' && onFocusDevice({ id: n.id, posX: n.posX, posZ: n.posZ })"
        >
          <span
            class="node-dot"
            :class="dcwLeafState(n)"
          />
          <div class="daq-meta">
            <span class="daq-name">{{ n.name }}</span>
            <span class="daq-node-sub">
              <span class="node-val mono">{{ n.value != null ? `${n.value.toFixed(tpl.decimals)} ${tpl.unit}` : '--' }}</span>
              <span class="node-dev">{{ n.deviceBindingId ? (deviceTwins.byId(n.deviceBindingId)?.name ?? $t('townView.k3own4q148')) : $t('townView.k3own4q148') }}</span>
            </span>
          </div>
          <span
            v-if="typeof n.posX === 'number'"
            class="scene-cur"
          >✓</span>
        </div>
        <div
          v-if="!dcwNodesByTpl.get(tpl.id)?.length"
          class="daq-empty-hint"
        >
          {{ $t('townView.k2tplxp0003') }}
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.daq-list, .scene-list { display: flex; flex-direction: column; gap: 4px; }
.daq-card {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 8px 9px;
  border-radius: var(--hud-r-md);
  background: var(--hud-panel-2);
  border: 1px solid rgba(31, 74, 58, 0.55);
  margin-bottom: 4px;
  cursor: grab;
  transition: transform 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease), background 0.15s var(--hud-ease);
}
.daq-card:hover {
  transform: translateY(-1px);
  border-color: rgba(53, 224, 160, 0.5);
  background: #12291f;
}
.daq-card:active { cursor: grabbing; }
.daq-ico {
  width: 34px;
  height: 34px;
  flex: none;
  display: grid;
  place-items: center;
  color: var(--hud-accent);
  border-radius: 9px;
  background: linear-gradient(160deg, #12291f, #0e1a24);
  border: 1px solid rgba(31, 74, 58, 0.65);
}
.daq-svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.daq-meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.daq-name { font-size: 12px; font-weight: 600; color: var(--hud-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.daq-code { font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.08em; color: var(--hud-faint); }
.daq-count {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--hud-accent);
  background: rgba(53, 224, 160, 0.1);
  border: 1px solid rgba(53, 224, 160, 0.28);
  padding: 0 6px;
  border-radius: 6px;
  line-height: 15px;
}
/* ── 树形目录:模板分组头(可展开,不可拖) + 节点叶子(可拖入场景) ── */
.daq-group { display: flex; flex-direction: column; }
.daq-card.tpl {
  cursor: pointer;
  margin-bottom: 0;
  user-select: none;
}
.daq-card.tpl:active { cursor: pointer; }
.daq-card.tpl:focus-visible { outline: 1px solid var(--hud-accent); outline-offset: 1px; }
.daq-caret {
  flex: none;
  font-size: 10px;
  color: var(--hud-faint);
  transition: transform 0.15s var(--hud-ease);
}
.daq-card.tpl.open .daq-caret { transform: rotate(90deg); }
.daq-card.tpl:hover { transform: none; }
.daq-add {
  flex: none;
  width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  font-size: 12px;
  line-height: 1;
  color: var(--hud-faint);
  background: transparent;
  border: 1px solid rgba(44, 69, 104, 0.7);
  border-radius: 6px;
  cursor: pointer;
  opacity: 0;
  transition:
    opacity 0.15s var(--hud-ease),
    color 0.15s var(--hud-ease),
    border-color 0.15s var(--hud-ease),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.daq-card.tpl:hover .daq-add,
.daq-card.tpl:focus-within .daq-add { opacity: 1; }
@media (hover: none) {
  .daq-add { opacity: 1; }
}
.daq-add:hover { color: var(--hud-accent); border-color: rgba(53, 224, 160, 0.5); }
.daq-add:active { transform: scale(0.9); }
.daq-children {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 2px 0 6px;
  padding-left: 16px;
  animation: daq-tree-in 0.16s var(--hud-ease);
}
@keyframes daq-tree-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}
.daq-node {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 5px 8px;
  border-radius: 7px;
  border: 1px solid transparent;
  cursor: default;
  transition:
    background 0.15s var(--hud-ease),
    border-color 0.15s var(--hud-ease),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
.daq-node:hover { background: #111b2c; border-color: rgba(44, 69, 104, 0.6); }
.daq-node[draggable='true'] { cursor: grab; }
.daq-node[draggable='true']:active { cursor: grabbing; transform: scale(0.98); }
.daq-node.placed { cursor: pointer; }
.daq-node.placed[draggable='true'] { cursor: grab; }
.node-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--hud-ok);
  box-shadow: 0 0 6px color-mix(in srgb, var(--hud-ok) 50%, transparent);
}
.node-dot.offline {
  background: transparent;
  border: 1px solid var(--hud-faint);
  box-shadow: none;
}
.node-dot.warn {
  background: var(--hud-amber);
  box-shadow: 0 0 6px color-mix(in srgb, var(--hud-amber) 50%, transparent);
}
.node-dot.alarm {
  background: var(--hud-danger);
  box-shadow: 0 0 6px color-mix(in srgb, var(--hud-danger) 60%, transparent);
}
.daq-node .daq-name { font-size: 11.5px; font-weight: 500; }
.daq-node-sub { display: flex; gap: 7px; align-items: baseline; min-width: 0; }
.node-val {
  flex: none;
  font-size: 10px;
  color: var(--hud-cyan);
}
.node-dev {
  font-size: 9.5px;
  color: var(--hud-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 104px;
}
.daq-empty-hint {
  padding: 4px 8px 6px 10px;
  font-size: 10px;
  color: var(--hud-faint);
}
/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
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
