/**
 * 小镇视图 — 窄屏抽屉 / 底部坞开合状态。
 *
 * 自 TownView.vue 抽出(纯结构搬移,行为与模板契约不变):
 *  - 左右轨折叠为底部抽屉页(sheet)的开合状态与 Esc 关闭;
 *  - 底部坞可收起横条的展开状态;
 *  - 回到桌面档自动清空(否则遮罩滞留屏幕)。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

export function useTownSheets() {
  /* ── 窄屏形态:左右轨折成底部抽屉(sheet),底部坞折成可收起横条 ──
   * 断点判据只用 useResponsive(全站唯一出处),不自己监听 innerWidth;
   * DOM 结构不随档位增删(形态切换全部交给 CSS 媒体查询),
   * 避免 SSR/水合不一致。抽屉协议与 AppSidebar 一致:遮罩 + Esc 关闭。 */
  const { isDesktop } = useResponsive()
  /** 当前打开的抽屉:'left' | 'right' | null */
  const sheetOpen = ref<'left' | 'right' | null>(null)
  /** 窄屏底部坞是否展开(默认收起,舞台优先) */
  const dockOpen = ref(false)
  function toggleSheet(side: 'left' | 'right') {
    sheetOpen.value = sheetOpen.value === side ? null : side
  }
  function closeSheet() {
    sheetOpen.value = null
  }
  function onSheetKey(e: KeyboardEvent) {
    if (e.key === 'Escape' && sheetOpen.value) closeSheet()
  }
  onMounted(() => window.addEventListener('keydown', onSheetKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onSheetKey))
  /** 回到桌面档必须清空抽屉状态,否则遮罩会滞留在屏幕上 */
  watch(isDesktop, (d) => {
    if (d) {
      sheetOpen.value = null
      dockOpen.value = false
    }
  })

  return { isDesktop, sheetOpen, dockOpen, toggleSheet, closeSheet, onSheetKey }
}
