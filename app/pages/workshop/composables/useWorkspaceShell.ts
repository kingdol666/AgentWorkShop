import { computed, onBeforeUnmount, onMounted, ref, watch, type ComputedRef } from 'vue'
import { useStorage } from '@vueuse/core'
import { useRoute } from 'vue-router'

/** 中部视图(P1 三视图 + P2 多通道同屏 + P5 RPG 小镇 + v17 人类群聊) */
export type CenterView = 'timeline' | 'chat' | 'lanes' | 'board' | 'split' | 'town' | 'inspector'

/** 数字快捷键 1-6 直切视图(非输入焦点时;控制台型键盘操作与 ⌘K 面板同一取向) */
const VIEW_KEYS: Record<string, CenterView> = {
  1: 'timeline',
  2: 'chat',
  3: 'lanes',
  4: 'board',
  5: 'split',
  6: 'town',
}
/**
 * 深链白名单:?view=chat/lanes/board/split/town 直达指定视图(可分享/收藏;通知跳转即用 view=chat)
 * inspector 只在窄屏出现(桌面它是右侧常驻栏),故不进深链白名单
 */
const VIEW_VALUES = new Set(['timeline', 'chat', 'lanes', 'board', 'split', 'town'])

/**
 * 控制台外壳层:视口档位(窄屏形态)/ 侧栏折叠与宽度拖拽 / 中部视图切换(含数字快捷键)。
 *
 * 这三件事合成一个 composable 而非再拆,是因为它们之间有真实耦合,拆开只会退化成一串
 * 互穿的回调:
 *  - applyTier 回到桌面档时要把窄屏第 4 区(inspector)复位成中部自己的区;
 *  - 数字快捷键的 Esc 分支要收起窄屏抽屉(leftOpen)。
 *
 * 依赖由页面注入(isDesktop:唯一判据;channelId:聚焦频道),本层**不重复**调用
 * useResponsive / useWorkspaceChannels —— 档位监听与 WS 订阅因此各自只有一份。
 */
export function useWorkspaceShell(
  isDesktop: ComputedRef<boolean>,
  channelId: ComputedRef<string | undefined>,
) {
  const { t } = useI18n()
  const route = useRoute()

  // 视口档位(唯一判据;SSR 期返回桌面档)——
  // 窄屏(≤1023)三栏仪表台只剩 ~460px 画布,必须换成「单通道示波器」形态
  // (isDesktop 由页面注入:判据仍只有 useResponsive 那一份)

  // 侧栏折叠(现代 harness 布局:左会话栏 / 右检查器可按需收起)
  // 形态差异只在挂载后生效:SSR/首帧一律按桌面结构渲染,客户端接管后才翻档,
  // 否则服务端 5 项切换条 vs 客户端 6 项会触发水合告警
  const mounted = ref(false)
  onMounted(() => {
    mounted.value = true
  })
  const narrowUI = computed(() => mounted.value && !isDesktop.value)

  const leftOpen = ref(true)
  const rightOpen = ref(true)
  /** 窄屏:左右侧栏都不再占位(收成覆盖式抽屉 / 并入切换条) */
  const applyTier = (desktop: boolean): void => {
    leftOpen.value = desktop
    rightOpen.value = desktop
    // 检查器只是窄屏的第 4 区:回桌面后它回到右栏,中部得有自己的区(否则中部空白)
    if (desktop && view.value === 'inspector') view.value = 'timeline'
  }
  onMounted(() => {
    if (!isDesktop.value) applyTier(false)
  })
  watch(isDesktop, d => applyTier(d))
  // 抽屉里选中频道后自动收起(窄屏少一次手动关闭)
  watch(channelId, (next, prev) => {
    if (prev !== undefined && next !== prev && narrowUI.value) leftOpen.value = false
  })

  // 侧栏宽度拖拽调节(PaneSplitter;localStorage 持久化,双击复位到默认值)
  const LEFT_W_DEFAULT = 248
  const RIGHT_W_DEFAULT = 300
  const leftWidth = useStorage('aw.harness.leftW', LEFT_W_DEFAULT)
  const rightWidth = useStorage('aw.harness.rightW', RIGHT_W_DEFAULT)
  const resizeLeft = (d: number): void => {
    leftWidth.value = Math.min(460, Math.max(220, leftWidth.value + d))
  }
  const resizeRight = (d: number): void => {
    rightWidth.value = Math.min(560, Math.max(240, rightWidth.value - d))
  }
  // 初始化消毒:陈旧持久化值(超出合法范围/异常类型)夹取回默认邻域,防布局被历史脏数据撑坏
  resizeLeft(0)
  resizeRight(0)

  // 视图切换(见文件头 CenterView):深链初始值 + 切换条选项 + 数字快捷键
  const initView = route.query.view
  const view = ref<CenterView>(
    typeof initView === 'string' && VIEW_VALUES.has(initView) ? initView as CenterView : 'timeline',
  )
  const viewOptions = computed(() => {
    const base = [
      { value: 'timeline', label: t('wsView.k3otu32010') },
      { value: 'chat', label: '群聊' },
      { value: 'lanes', label: 'Agent lanes' },
      { value: 'board', label: t('wsView.k3ko7a8011') },
      { value: 'split', label: t('wsView.k3xbmo012') },
      { value: 'town', label: t('wsView.k1cz0pbw013') },
    ]
    // 窄屏「一次一区」:检查器不占侧栏,并入切换条(四区都由同一条承载)
    return narrowUI.value ? [...base, { value: 'inspector', label: t('wsView.inspector') }] : base
  })
  const onViewKey = (ev: KeyboardEvent): void => {
    // 窄屏抽屉:Esc 收起(与全站侧栏抽屉一致)
    if (ev.key === 'Escape' && narrowUI.value && leftOpen.value) {
      leftOpen.value = false
      return
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return
    const t = ev.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    const next = VIEW_KEYS[ev.key]
    if (!next || !channelId.value) return
    ev.preventDefault()
    view.value = next
  }
  onMounted(() => window.addEventListener('keydown', onViewKey))
  onBeforeUnmount(() => window.removeEventListener('keydown', onViewKey))

  return {
    mounted,
    narrowUI,
    leftOpen,
    rightOpen,
    leftWidth,
    rightWidth,
    resizeLeft,
    resizeRight,
    LEFT_W_DEFAULT,
    RIGHT_W_DEFAULT,
    view,
    viewOptions,
    onViewKey,
  }
}
