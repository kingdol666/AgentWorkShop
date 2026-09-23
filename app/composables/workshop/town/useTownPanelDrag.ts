/**
 * 小镇视图 — 浮层面板拖拽 / 位置记忆。
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约逐字保持):
 *  - 抓取面板标题栏(抓手)自由拖动,避免堆叠在底部;
 *  - 位置经 localStorage 记忆(键 'aw-town-panel-pos' 不变,旧存档仍生效);
 *  - 拖动期间禁用文本选择/切抓取光标,松手恢复。
 */
import { onMounted, reactive } from 'vue'

export function useTownPanelDrag() {
  /* ============================================================
   * 可拖动面板(对象属性卡/边界面板/员工会话台):
   * 抓取标题栏拖动,自由移动避免堆叠在底部;位置经 localStorage 记忆
   * ============================================================ */
  const panelPos = reactive<Record<string, { x: number, y: number }>>({})
  const PANEL_POS_KEY = 'aw-town-panel-pos'
  function restorePanelPos(): void {
    if (typeof localStorage === 'undefined') return
    try {
      const saved = JSON.parse(localStorage.getItem(PANEL_POS_KEY) || '{}') as Record<string, { x: number, y: number }>
      for (const k of Object.keys(saved)) {
        if (saved[k] && Number.isFinite(saved[k].x)) panelPos[k] = saved[k]
      }
    }
    catch { /* 损坏的存档忽略 */ }
  }
  function savePanelPos(): void {
    try {
      localStorage.setItem(PANEL_POS_KEY, JSON.stringify(panelPos))
    }
    catch { /* 隐私模式等忽略 */ }
  }
  let dragToken: { frame: HTMLElement, panel: HTMLElement, offX: number, offY: number } | null = null

  /** 抓取面板标题栏开始拖动(pointerdown) */
  function onPanelGripDown(e: PointerEvent, key: string): void {
    const grip = e.currentTarget as HTMLElement
    const panel = grip.closest<HTMLElement>('.drag-panel')
    const frame = grip.closest<HTMLElement>('.town-frame')
    if (!panel || !frame) return
    e.preventDefault()
    const rect = panel.getBoundingClientRect()
    const fr = frame.getBoundingClientRect()
    // 由「底部居中」布局切换为显式定位(之后完全随拖动)
    panel.style.left = `${rect.left - fr.left}px`
    panel.style.top = `${rect.top - fr.top}px`
    panel.style.bottom = 'auto'
    panel.style.transform = 'none'
    panelPos[key] = { x: rect.left - fr.left, y: rect.top - fr.top }
    dragToken = {
      frame,
      panel,
      offX: e.clientX - rect.left,
      offY: e.clientY - rect.top,
    }
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'grabbing'
    const onMove = (ev: PointerEvent): void => {
      const tk = dragToken
      if (!tk) return
      const fr2 = tk.frame.getBoundingClientRect()
      const x = ev.clientX - tk.offX - fr2.left
      const y = ev.clientY - tk.offY - fr2.top
      const pw = tk.panel.offsetWidth
      const nx = Math.max(-pw + 90, Math.min(x, fr2.width - 30))
      const ny = Math.max(4, Math.min(y, fr2.height - 34))
      tk.panel.style.left = `${nx}px`
      tk.panel.style.top = `${ny}px`
      panelPos[key] = { x: nx, y: ny }
    }
    const onUp = (): void => {
      dragToken = null
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      savePanelPos()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  onMounted(() => restorePanelPos())

  return { panelPos, restorePanelPos, savePanelPos, onPanelGripDown }
}
