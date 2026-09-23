<script setup lang="ts">
/**
 * 小镇视图 · 左轨(设备资源 / 数采 / 智控 / 场景管理)。
 *
 * 自 TownView.vue 抽出(纯结构搬移,模板与样式逐字保持):
 * 数据经 props 传入、动作回调亦经 props 传入(父组件仍是共享状态的唯一持有者,
 * 子组件不新建任何响应式副本);样式为本组件模板专属规则,随模板一并搬移。
 */
import TownDaqTree from './TownDaqTree.vue'
import TownDcwTree from './TownDcwTree.vue'
import TownChannelDock from './TownChannelDock.vue'
import WorkshopAssetLibrary from '@/app/components/workshop/AssetLibrary.vue'

import type { TownLeftRailProps } from '@/app/composables/workshop/town/town-relay-props'

defineProps<TownLeftRailProps>()
</script>

<template>
  <aside
    id="town-rail-left"
    class="rail rail-left"
    :class="{ 'sheet-open': sheetOpen === 'left' }"
  >
    <!-- 窄屏抽屉头(桌面档 CSS 隐藏):抓手 + 标题 + 关闭 -->
    <div class="sheet-hd">
      <span
        class="sheet-grip"
        aria-hidden="true"
      />
      <span class="sheet-hd-t">{{ $t('townView.k1k75lzy030') }}</span>
      <button
        type="button"
        class="sheet-x"
        :aria-label="$t('common.close')"
        @click="closeSheet"
      >
        ✕
      </button>
    </div>
    <section class="panel">
      <div class="panel-hd">
        <h3>{{ $t('townView.k1k75lzy030') }}</h3>
        <span class="panel-tag">{{ deviceModels.length }}</span>
      </div>
      <WorkshopAssetLibrary class="lib-embed" />
    </section>

    <section class="panel">
      <div class="panel-hd">
        <h3>{{ $t('townView.k2gwyas031') }}</h3>
        <span class="panel-tag">{{ daqTwins.length }}</span>
      </div>
      <!-- 采集总控(server DaqController:全局启停 + 缺省周期;所有节点到期由其统一调度) -->
      <TownDaqTree
        :mode="mode"
        :tree-open="treeOpen"
        :daq-templates="daqTemplates"
        :daq-nodes-by-tpl="daqNodesByTpl"
        :device-twins="deviceTwins"
        :daq="daq"
        :daq-leaf-state="daqLeafState"
        :toggle-tree-group="toggleTreeGroup"
        :create-daq-from-template="createDaqFromTemplate"
        :on-daq-node-drag-start="onDaqNodeDragStart"
        :on-focus-device="onFocusDevice"
      />
    </section>

    <section class="panel">
      <div class="panel-hd">
        <h3>{{ $t('townView.km7ayhi033') }}</h3>
        <span class="panel-tag">{{ dcw.nodes.length }}</span>
      </div>
      <TownDcwTree
        :mode="mode"
        :tree-open="treeOpen"
        :dcw-templates="dcwTemplates"
        :dcw-nodes-by-tpl="dcwNodesByTpl"
        :device-twins="deviceTwins"
        :dcw-leaf-state="dcwLeafState"
        :toggle-tree-group="toggleTreeGroup"
        :create-dcw-from-template="createDcwFromTemplate"
        :on-dcw-node-drag-start="onDcwNodeDragStart"
        :on-focus-device="onFocusDevice"
      />
    </section>

    <section class="panel">
      <div class="panel-hd">
        <h3>{{ $t('townView.k1c9n911034') }}</h3>
        <span class="panel-tag">{{ dockChannels.length }}</span>
      </div>
      <TownChannelDock
        :mode="mode"
        :dock-channels="dockChannels"
        :dock-hint="dockHint"
        :on-channel-drag-start="onChannelDragStart"
        :on-dock-card-click="onDockCardClick"
      />
    </section>
  </aside>
</template>

<style scoped>
.rail {
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  /* 轨道微渐变:与场景天穹同族的纵深(左轨亮→右轨暗,视线向舞台聚焦) */
  background: linear-gradient(180deg, #0a101c 0%, #080d16 100%);
}
.rail-left { border-right: 1px solid var(--hud-line-soft); }
.rail::-webkit-scrollbar { width: 8px; }
.rail::-webkit-scrollbar-thumb { background: #1c2942; border-radius: 4px; border: 2px solid #080d16; }
.rail::-webkit-scrollbar-track { background: transparent; }
.panel {
  position: relative;
  background: linear-gradient(180deg, #101827 0%, #0d1420 100%);
  border: 1px solid var(--hud-line);  border-radius: var(--hud-r-lg);
  padding: 12px;
  flex: none;
  /* 玻璃光泽:顶部内高光(面板上缘受光)+ 深色外投影(悬浮层次) */
  box-shadow:
    inset 0 1px 0 rgba(143, 176, 220, 0.07),
    0 10px 28px rgba(3, 7, 14, 0.45);
}
/* 面板顶部光泽扫光:与 topnav 呼吸光同 motif,让面板像仪表台玻璃 */
.panel::before {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 44px;
  border-radius: var(--hud-r-lg) var(--hud-r-lg) 0 0;
  background: linear-gradient(180deg, rgba(120, 165, 220, 0.055), transparent);
  pointer-events: none;
}
.panel-hd {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.panel-hd h3 {
  position: relative;
  margin: 0;
  padding-left: 11px;
  font-size: 12.5px;
  font-weight: 700;
  letter-spacing: 0.02em;
  flex: 1;
}
/* 左缘数据条:与 3D 场景名牌(makeLabel)同一 motif,双端一致 */
.panel-hd h3::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  width: 3px;
  height: 12px;
  transform: translateY(-50%);
  background: var(--hud-accent);
  border-radius: 2px;
  box-shadow: 0 0 8px color-mix(in srgb, var(--hud-accent) 45%, transparent);
}
.panel-tag {
  font-family: var(--font-mono);
  font-size: 9.5px;
  color: var(--hud-cyan);
  background: rgba(65, 200, 244, 0.1);
  border: 1px solid rgba(65, 200, 244, 0.25);
  padding: 0 6px;
  border-radius: 6px;
  line-height: 15px;
}
/* ===== 左轨:资源 / DAQ / 场景管理 ===== */
.lib-embed { margin: -4px 0 0; }

/* ── HUD 上电进场(夜航仪 Boot 序列):左轨 → 右轨 → 底部坞 依次浮现,
 *    一次编排好的 page load,而非散落微交互;reduced-motion 全收敛。── */
@media (prefers-reduced-motion: no-preference) {
  .rail-left,
  .rail-right,
  .dock {
    animation: hud-boot 0.52s cubic-bezier(0.22, 0.68, 0.36, 1) backwards;
  }
  .rail-left { animation-delay: 0.04s; }
  .rail-right { animation-delay: 0.15s; }
  .dock { animation-delay: 0.26s; }
}

@keyframes hud-boot {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
/* ============================================================
 * 窄屏形态零件(≥1024 桌面一律不出现:形态由下面的媒体查询切换)
 * ============================================================ */
.sheet-btn,
.dock-toggle,
.sheet-hd { display: none; }

/* 键盘可达:焦点环(设计稿 --focus-ring;补回 scoped 属性选择器降低的一档特异性,与 .town-view 规则同效) */
button:focus-visible,
input:focus-visible,
select:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--hud-bg), 0 0 0 4px rgba(65, 200, 244, 0.45);
  border-radius: 6px;
}

/* ═══════════════════════════════════════════════════════════════
 * 窄屏(≤1023)= 手持巡检终端,而不是"缩小的控制室":
 *   · 3D 舞台占满视口宽度,纵向吃满顶栏/状态栏之间的全部高度;
 *   · 左右轨从固定侧栏改为底部抽屉页(sheet),顶栏两个按钮开合
 *     (遮罩 / Esc / 点空白关闭,协议与 AppSidebar 抽屉一致);
 *   · 底部坞折成可收起的横条,默认收起,不再压舞台;
 *   · 刻度字号地板:标签 ≥11.5px、正文 ≥13px;可点目标 ≥40px。
 * 断点与 useResponsive(≥1024 桌面)同源;形态全部由 CSS 决定。
 * ═══════════════════════════════════════════════════════════════ */
@media (max-width: 1023px) {
  /* ── 左右轨 → 底部抽屉页(sheet) ── */
  .rail {
    position: fixed;
    left: 0;
    right: 0;
    top: auto;
    bottom: 0;
    z-index: 70;
    width: auto;
    max-height: min(76dvh, 640px);
    padding: 0 10px 12px;
    gap: 8px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 0;
    border-top: 1px solid var(--hud-line-hi);
    border-radius: 16px 16px 0 0;
    background: linear-gradient(180deg, #0c1420 0%, #080d16 46%);
    box-shadow: 0 -18px 46px rgba(0, 0, 0, 0.6);
    transform: translateY(103%);
    visibility: hidden;
    /* 关门:位移走完再隐藏(离散属性用延时);开门:立即可见 */
    transition: transform 0.26s var(--hud-ease), visibility 0s linear 0.26s;
  }
  .rail.sheet-open {
    transform: none;
    visibility: visible;
    transition: transform 0.26s var(--hud-ease), visibility 0s;
  }
  .rail-left,
  .rail-right { border-right: 0; border-left: 0; }
  .rail .panel { flex: none; }
  .sheet-hd {
    display: flex;
    align-items: center;
    gap: 8px;
    position: sticky;
    top: 0;
    z-index: 2;
    margin: 0 -10px 2px;
    padding: 13px 12px 9px;
    background: linear-gradient(180deg, #0e1725, #0c1420);
    border-bottom: 1px solid var(--hud-line-soft);
  }
  .sheet-grip {
    position: absolute;
    left: 50%;
    top: 6px;
    width: 40px;
    height: 3px;
    margin-left: -20px;
    border-radius: 2px;
    background: #2c4568;
  }
  .sheet-hd-t { font-size: 13px; font-weight: 700; color: var(--hud-text); letter-spacing: 0.04em; }
  .sheet-x {
    margin-left: auto;
    width: 40px;
    height: 40px;
    flex: none;
    border-radius: 8px;
    border: 1px solid var(--hud-line);
    background: #101a2b;
    color: var(--hud-dim);
    font-size: 15px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .rail { transition: none; }
}

/* ── 触摸目标:窄屏所有可点元件 ≥40px 高(与 .town-view button 同效) ── */
@media (max-width: 1023px) {
  button { min-height: 40px; }
}
</style>
