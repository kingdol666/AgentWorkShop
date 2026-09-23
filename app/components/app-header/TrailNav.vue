<script setup lang="ts">
import { useRouteTrailStore } from '@/app/stores/route-trail'

defineProps<{
  /** 标绘轨只在客户端挂载后渲染(SSR 无航迹可标) */
  hydrated: boolean
}>()

const route = useRoute()
const { t } = useI18n()
const trail = useRouteTrailStore()
const { metaFor } = useRouteMeta()

const go = (path: string) => {
  if (path !== route.path) {
    navigateTo(path)
  }
}

/**
 * 关闭航点标签页:
 * - 非当前页 → 仅从航迹移除;
 * - 当前页 → 先选好跳转目标(优先左侧相邻航点,其次右侧,兜底仪表盘)再移除并跳转,
 *   避免关闭后停留在一个已无标签的路由上(watcher 会在跳转后 visit 目标页,不会回补被关页)。
 */
const closeWaypoint = (path: string) => {
  const idx = trail.remove(path)
  if (path !== route.path) return
  const rest = trail.waypoints
  const target = rest[Math.min(Math.max(idx - 1, 0), Math.max(rest.length - 1, 0))]?.path ?? '/'
  navigateTo(target)
}
</script>

<template>
  <nav
    class="trail"
    :aria-label="t('header.trail')"
  >
    <transition-group
      name="stamp"
      tag="div"
      class="trail-row"
    >
      <template v-if="hydrated">
        <template
          v-for="(w, i) in trail.waypoints"
          :key="w.path"
        >
          <span
            v-if="i > 0"
            :key="`link-${w.path}`"
            class="trail-link"
            aria-hidden="true"
          />
          <div
            class="trail-node"
            :class="{ active: w.path === route.path }"
            role="button"
            tabindex="0"
            :title="metaFor(w.path).title"
            @click="go(w.path)"
            @keydown.enter.prevent="go(w.path)"
          >
            <span
              class="node-icon"
              :class="metaFor(w.path).icon"
            />
            <span class="node-title">{{ metaFor(w.path).title }}</span>
            <button
              class="node-close"
              :aria-label="$t('appHeader.kzwjv99001', { p0: metaFor(w.path).title })"
              :title="$t('appHeader.kzwjv99001', { p0: metaFor(w.path).title })"
              @click.stop="closeWaypoint(w.path)"
            >
              <span class="i-tabler-x" />
            </button>
          </div>
        </template>
      </template>
    </transition-group>
  </nav>
</template>

<style scoped>
.trail {
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
  -webkit-mask-image: linear-gradient(90deg, transparent 0, black 8px, black calc(100% - 18px), transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0, black 8px, black calc(100% - 18px), transparent 100%);
}

.trail::-webkit-scrollbar {
  display: none;
}

.trail-row {
  display: flex;
  align-items: center;
  gap: 0;
  padding: 3px 4px;
  white-space: nowrap;
}

/* 航点间细线:同色系 hairline */
.trail-link {
  flex: 0 0 auto;
  width: 14px;
  height: 1px;
  background: var(--line-strong);
}

/* 航点:chip 圆角描边,悬停抬亮,当前页墨色填充(ink pill) */
.trail-node {
  position: relative;
  display: inline-flex;
  flex: 0 0 auto;
  gap: 6px;
  align-items: center;
  height: 32px;
  padding: 0 12px;
  font-family: var(--font-body);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: var(--app-text, var(--ink-soft));
  cursor: pointer;
  background: var(--paper-deep);
  border: 1px solid var(--line);
  border-radius: var(--radius-pill);
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.trail-node:hover {
  color: var(--ink);
  background: var(--paper-tint);
  border-color: var(--line-strong);
}

.trail-node:active {
  transform: scale(0.98);
}

.trail-node:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.trail-node.active {
  color: var(--on-accent);
  background: var(--accent);
  border-color: var(--accent);
}

.node-icon {
  font-size: 13px;
}

.node-title {
  max-width: 132px;
  overflow: hidden;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: max-width 0.18s var(--ease-out-quart), margin 0.18s var(--ease-out-quart), opacity 0.18s var(--ease-out-quart);
}

/* 标签关闭钮:槽位常驻(零布局抖动),悬停标签时图标淡入展开(浏览器页签交互);
 * 当前页签(朱砂底)用白色保证对比 */
.node-close {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: 4px;
  font-size: 12px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: var(--radius-chip);
  opacity: 0;
  transform: scale(0.6);
  transition:
    opacity 0.18s var(--ease-out-quart),
    transform 0.18s var(--ease-out-quart),
    color var(--transition-fast),
    background var(--transition-fast);
}

.trail-node:hover .node-close,
.trail-node:focus-within .node-close {
  opacity: 1;
  transform: none;
}

.node-close:hover {
  color: var(--ink);
  background: var(--hover-tint);
}

.node-close:active {
  transform: scale(0.9);
}

.trail-node.active .node-close {
  color: color-mix(in srgb, var(--on-accent) 85%, transparent);
}

.trail-node.active .node-close:hover {
  color: var(--on-accent);
  background: color-mix(in srgb, var(--on-accent) 18%, transparent);
}

.node-close:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

/* 航点进场:轻抬升淡入 */
.stamp-enter-active {
  transition: opacity 0.22s var(--ease-out-quart), transform 0.22s var(--ease-out-quart);
}

.stamp-enter-from {
  opacity: 0;
  transform: translateY(4px);
}

.stamp-leave-active {
  position: absolute;
  transition: opacity 0.14s ease;
}

.stamp-leave-to {
  opacity: 0;
}

.stamp-move {
  transition: transform 0.22s ease;
}

@media (max-width: 899px) {
  .trail {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .stamp-enter-active,
  .stamp-leave-active,
  .stamp-move {
    transition: none;
  }
}
</style>
