<script setup lang="ts">
/**
 * 小镇视图 — 顶部导航(topnav)。
 *
 * 自 TownView.vue 抽出(纯结构搬移):品牌徽记 / 浏览-编辑模式段 / 保存布局 /
 * 告警与 FPS 徽标 / 用户头像 / 窄屏左右轨抽屉开关。
 * 只读数据经 props 传入,交互经 emits 交回父组件(状态仍由父组件持有,不做本地副本)。
 *
 * 注:控制室设计令牌(--hud-*)与根 .town-view 规则留在 TownView.vue(令牌必须定义在
 * 真正带 TownView scope id 的根元素上,scoped 编译后才会命中);本组件只消费继承值。
 */
defineProps<{
  mode: 'browse' | 'edit'
  fps: number
  activeAlarmCount: number
  userName: string
  saveState: { state: 'idle' | 'dirty' | 'saving' | 'saved' | 'error', at: number } | null
  saveStateLabel: string
  sheetOpen: 'left' | 'right' | null
}>()

const emit = defineEmits<{
  (e: 'toggle-mode' | 'save-layout'): void
  (e: 'toggle-sheet', side: 'left' | 'right'): void
}>()
</script>

<template>
  <header
    class="topnav"
    :class="{ 'sheet-on': sheetOpen }"
  >
    <div class="brand">
      <svg
        class="brand-glyph"
        viewBox="0 0 32 32"
        fill="none"
        aria-hidden="true"
      >
        <path
          d="M16 2.5 27.5 9v14L16 29.5 4.5 23V9L16 2.5Z"
          stroke="#35e0a0"
          stroke-width="1.6"
        />
        <path
          d="M16 8.2 22.5 12v8L16 23.8 9.5 20v-8L16 8.2Z"
          stroke="#41c8f4"
          stroke-width="1.3"
          opacity=".85"
        />
        <circle
          cx="16"
          cy="16"
          r="2.4"
          fill="#35e0a0"
        />
        <circle
          cx="25.5"
          cy="7.5"
          r="1.6"
          fill="#41c8f4"
        />
      </svg>
      <div>
        <div class="brand-name">
          DIGITAL <em>TWIN</em>
        </div>
        <div class="brand-sub">
          AGENTWORKSHOP · {{ $t('townView.klyi8yg127') }}
        </div>
      </div>
    </div>
    <nav
      class="nav-tabs"
      :aria-label="$t('townView.k1c9jyta001')"
    >
      <div class="seg">
        <button
          :class="{ on: mode === 'browse' }"
          @click="mode === 'edit' && emit('toggle-mode')"
        >
          {{ $t('townView.k48dwh027') }}
        </button>
        <button
          :class="{ on: mode === 'edit' }"
          @click="mode === 'browse' && emit('toggle-mode')"
        >
          {{ $t('townView.k45eb0028') }}
        </button>
      </div>
      <button
        class="nav-action"
        :disabled="mode !== 'edit'"
        :title="mode === 'edit' ? $t('townView.saveLayoutTip') : $t('townView.readonlyTip')"
        @click="emit('save-layout')"
      >
        {{ $t('townView.k1b3bk8t029') }}
      </button>
      <span
        v-if="saveState && saveState.state !== 'idle'"
        class="save-chip"
        :class="`s-${saveState.state}`"
      >{{ saveStateLabel }}</span>
    </nav>
    <div class="nav-right">
      <span
        class="nav-chip mono"
        :class="{ 'nav-bell-warn': activeAlarmCount > 0 }"
        :title="$t('townView.k1fsi3ir002')"
      >◉ {{ activeAlarmCount }}</span>
      <span class="nav-chip mono nav-fps">{{ fps }} FPS</span>
      <div
        class="avatar-chip nav-user"
        :title="$t('townView.k1demf38003')"
      >
        <div class="avatar-fallback">
          {{ userName.slice(0, 2).toUpperCase() }}
        </div>
        <span>{{ userName || $t('townView.k1pub99m139') }}</span>
      </div>

      <!-- 窄屏:左/右轨开合(≥1024 由 CSS 隐藏) -->
      <button
        type="button"
        class="sheet-btn"
        :class="{ on: sheetOpen === 'left' }"
        aria-controls="town-rail-left"
        :aria-expanded="sheetOpen === 'left' ? 'true' : 'false'"
        :title="$t('townView.k1k75lzy030')"
        @click="emit('toggle-sheet', 'left')"
      >
        <svg
          class="sheet-ico"
          viewBox="0 0 24 24"
          aria-hidden="true"
        ><path d="M4 6h16M4 12h11M4 18h16" /></svg>
        <span class="sheet-btn-t">{{ $t('townView.k1k75lzy030') }}</span>
      </button>
      <button
        type="button"
        class="sheet-btn"
        :class="{ on: sheetOpen === 'right' }"
        aria-controls="town-rail-right"
        :aria-expanded="sheetOpen === 'right' ? 'true' : 'false'"
        :title="$t('townView.k17dkhgd112')"
        @click="emit('toggle-sheet', 'right')"
      >
        <svg
          class="sheet-ico"
          viewBox="0 0 24 24"
          aria-hidden="true"
        ><path d="M20 6H4M20 12H9M20 18H4" /></svg>
        <span class="sheet-btn-t">{{ $t('townView.k17dkhgd112') }}</span>
      </button>
    </div>
  </header>
</template>

<style scoped>
/* ============================================================
 * DIGITAL TWIN · 控制室 UI(设计稿 1:1 架构)
 * topnav 50 / 三栏网格(250 · 1fr · 342) / dock / statusbar 30
 * ============================================================ */

/* ===== 顶部导航 ===== */
.topnav {
  height: 50px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 16px;
  background: linear-gradient(180deg, #0c1320, #0a101b);
  border-bottom: 1px solid var(--hud-line-soft);
  position: relative;
  z-index: 60;
}
/* 顶栏下缘呼吸光:制造深度,不做渐变横幅 */
.topnav::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  bottom: -1px;
  height: 1px;
  background: linear-gradient(90deg, transparent 4%, rgba(53, 224, 160, 0.35) 50%, transparent 96%);
  pointer-events: none;
}
.brand { display: flex; align-items: center; gap: 10px; min-width: 230px; }
.brand-glyph { width: 26px; height: 26px; flex: none; }
.brand-name { font-weight: 800; font-size: 14.5px; letter-spacing: 0.06em; }
.brand-name em { font-style: normal; color: var(--hud-accent); }
.brand-sub { font-size: 10px; color: var(--hud-faint); letter-spacing: 0.18em; margin-top: 2px; }
.nav-tabs {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 10px;
  align-items: center;
}
.nav-action {
  background: transparent;
  height: 32px;
  padding: 0 14px;
  border: 1px solid var(--hud-line-hi);
  border-radius: var(--hud-r-sm);
  color: var(--hud-dim);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s var(--hud-ease), color 0.15s var(--hud-ease), border-color 0.15s var(--hud-ease);
}
.nav-action:hover { background: #14203a; border-color: #33507c; }
.save-chip {
  font-family: var(--font-mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid var(--hud-line-hi);
  color: var(--hud-dim);
}
.save-chip.s-dirty { color: var(--hud-amber); border-color: rgba(246, 196, 83, 0.4); }
.save-chip.s-saving { color: var(--hud-dim); }
.save-chip.s-saved { color: var(--hud-accent); border-color: rgba(53, 224, 160, 0.4); }
.save-chip.s-error { color: var(--hud-danger); border-color: rgba(255, 107, 107, 0.4); }
.nav-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.nav-chip {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--hud-dim);
  padding: 4px 9px;
  border: 1px solid var(--hud-line);
  border-radius: 999px;
  letter-spacing: 0.06em;
}
.avatar-chip {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 3px 10px 3px 3px;
  background: var(--hud-panel-2);
  border: 1px solid var(--hud-line);
  border-radius: 999px;
}
.avatar-chip span { font-size: 12px; color: var(--hud-text); }
/* ── 孪生 HUD 字号地板(桌面档) ────────────────────────────────────────────
 * 9px 徽标字在暗底上不可读;桌面档统一抬到 ≥10px,窄屏再抬一档(见媒体查询)。
 * 例外:仅纯装饰性小字保留 9px。 */
.avatar-fallback {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: 10.5px;
  font-weight: 700;
  color: #04120c;
  background: linear-gradient(135deg, var(--hud-accent), var(--hud-cyan));
}
/* 顶栏模式段(浏览/编辑) */
.seg {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 4px;
  background: var(--hud-panel);
  border: 1px solid var(--hud-line);
  border-radius: 10px;
}
.seg button {
  padding: 4px 16px;
  border-radius: 6px;
  font-size: 11.5px;
  color: var(--hud-dim);
  font-weight: 600;
  transition: background 0.15s var(--hud-ease), color 0.15s var(--hud-ease);
}
.seg button.on {
  background: var(--hud-accent);
  color: #04120c;
  box-shadow: 0 0 12px rgba(53, 224, 160, 0.35);
}

/* ── 顶部导航(响应式档位):桌面档隐藏抽屉开关 ── */
.sheet-btn,
.dock-toggle,
.sheet-hd { display: none; }
.sheet-mask {
  position: fixed;
  inset: 0;
  z-index: 65;
  background: rgba(4, 8, 14, 0.6);
  backdrop-filter: blur(2px);
}

/* ── 窄屏:顶栏折两行(品牌 + 告警 + 抽屉开关 / 模式段) ── */
@media (max-width: 1023px) {
  /* ── 顶栏:折两行(品牌 + 告警 + 抽屉开关 / 模式段) ── */
  .topnav {
    height: auto;
    min-height: 46px;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    padding: 6px 10px 8px;
  }
  .brand { order: 0; flex: 1 1 auto; min-width: 0; gap: 8px; }
  .brand > div { min-width: 0; overflow: hidden; }
  .brand-name { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .nav-right { order: 1; flex: none; margin-left: 0; gap: 6px; }
  /* 模式段整行:不再绝对定位居中(那会与品牌/开关互相压字) */
  .nav-tabs { order: 2; flex: 1 1 100%; position: static; transform: none; gap: 8px; }
  .seg button { padding: 0 14px; font-size: 13px; }
  .nav-action { height: 40px; padding: 0 12px; font-size: 13px; }
  .save-chip { font-size: 11.5px; }
  .nav-chip { font-size: 11.5px; padding: 5px 8px; }
  .avatar-chip { padding: 3px 8px 3px 3px; }
  .avatar-chip span { font-size: 13px; }
  .avatar-fallback { width: 26px; height: 26px; font-size: 11.5px; }
  /* 抽屉开关:图标 + 名称,≥40px 触摸目标 */
  .sheet-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 40px;
    padding: 0 10px;
    border-radius: var(--hud-r-sm);
    border: 1px solid #27395c;
    background: #101a2b;
    color: var(--hud-dim);
    font-size: 12.5px;
    font-weight: 600;
    white-space: nowrap;
  }
  .sheet-btn.on {
    color: #04120c;
    background: var(--hud-accent);
    border-color: var(--hud-accent);
    box-shadow: 0 0 12px rgba(53, 224, 160, 0.3);
  }
  .sheet-ico {
    width: 16px;
    height: 16px;
    flex: none;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .topnav.sheet-on { z-index: 71; }
}

/* ── <640 单列档:进一步让位给舞台(品牌文字收成徽记,名字收进头像) ── */
@media (max-width: 639px) {
  .brand { flex: none; }
  .brand > div { display: none; }
  .brand-glyph { width: 28px; height: 28px; }
  .nav-fps { display: none; }
  .nav-user span { display: none; }
  .avatar-chip { padding: 3px; }
  .sheet-btn-t { display: none; }
  .sheet-btn { padding: 0 10px; }
}
</style>
