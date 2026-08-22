<script setup lang="ts">
/**
 * PaneSplitter — 面板宽度拖拽分隔条(可复用)。
 * pointer capture 拖动 → resize(deltaPx);双击 → reset;键盘 ←/→ 微调(a11y,Shift 加速)。
 * 父组件负责应用 delta 到目标宽度并夹取范围(左分隔条 width+=d;右分隔条/抽屉 width-=d)。
 * variant:
 *  - divider: 常驻居中 hairline(承担面板间真实分隔线,替代面板自带 border)
 *  - bare: 无常驻线,仅 hover 出现 grip(叠加在既有边缘上,如抽屉左缘)
 */
const props = withDefaults(defineProps<{
  label?: string
  variant?: 'divider' | 'bare'
}>(), {
  label: '拖拽调节面板宽度',
  variant: 'divider',
})

const emit = defineEmits<{
  (e: 'resize', deltaPx: number): void
  (e: 'reset'): void
}>()

const dragging = ref(false)
let lastX = 0

const onPointerDown = (e: PointerEvent): void => {
  if (e.button !== 0) return
  dragging.value = true
  lastX = e.clientX
  document.body.classList.add('aw-pane-dragging')
  ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
}
const onPointerMove = (e: PointerEvent): void => {
  if (!dragging.value) return
  const dx = e.clientX - lastX
  lastX = e.clientX
  if (dx !== 0) emit('resize', dx)
}
const endDrag = (e: PointerEvent): void => {
  if (!dragging.value) return
  dragging.value = false
  document.body.classList.remove('aw-pane-dragging')
  try {
    ;(e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId)
  }
  catch {
    /* 指针已释放 */
  }
}
const onKeydown = (e: KeyboardEvent): void => {
  const step = e.shiftKey ? 48 : 12
  if (e.key === 'ArrowLeft') {
    emit('resize', -step)
    e.preventDefault()
  }
  else if (e.key === 'ArrowRight') {
    emit('resize', step)
    e.preventDefault()
  }
}
</script>

<template>
  <div
    class="pane-splitter"
    :class="[variant, { dragging }]"
    role="separator"
    aria-orientation="vertical"
    :aria-label="props.label"
    tabindex="0"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="endDrag"
    @pointercancel="endDrag"
    @dblclick="emit('reset')"
    @keydown="onKeydown"
  >
    <span class="grip" />
  </div>
</template>

<style scoped>
.pane-splitter {
  position: relative;
  z-index: 5;
  flex: 0 0 9px;
  cursor: col-resize;
  touch-action: none;
  outline: none;
}
/* divider 形态:常驻居中 hairline(即面板间分隔线本身) */
.pane-splitter::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: 4px;
  width: 1px;
  background: transparent;
  transition: background var(--transition-fast);
}
.pane-splitter.divider::before {
  background: var(--line);
}
.pane-splitter:hover::before,
.pane-splitter:focus-visible::before,
.pane-splitter.dragging::before {
  background: var(--ink);
}
.pane-splitter.bare::before {
  left: 2px;
}
.pane-splitter.bare:hover::before,
.pane-splitter.bare.dragging::before {
  background: color-mix(in srgb, var(--ink) 35%, transparent);
}
/* 中心 grip:竖向小圆条,hover/drag 显形 */
.grip {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 2px;
  height: 18px;
  background: var(--ink);
  border-radius: var(--radius-pill);
  opacity: 0;
  transform: translate(-50%, -50%);
  transition: opacity var(--transition-fast);
}
.pane-splitter:hover .grip,
.pane-splitter:focus-visible .grip,
.pane-splitter.dragging .grip {
  opacity: 0.45;
}
.pane-splitter.dragging .grip {
  opacity: 0.85;
}
</style>
