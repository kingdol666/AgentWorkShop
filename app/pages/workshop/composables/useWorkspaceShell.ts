import { computed, onMounted, ref, watch, type ComputedRef } from 'vue'
import { useStorage } from '@vueuse/core'
import { useRoute, useRouter } from 'vue-router'

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
 * 旧 ?view=sessions 已并入对话页,初始化时映射到 chat(不 404)。
 */
const VIEW_VALUES = new Set(['timeline', 'chat', 'lanes', 'board', 'split', 'town'])

/**
 * 控制台外壳层:视口档位(窄屏形态)/ 侧栏折叠与宽度拖拽 / 中部视图切换(含数字快捷键)。
 *
 * 外壳状态在此统一：视口档位、侧栏状态与宽度、可分享视图和数字快捷键。
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
  const router = useRouter()
  const inspecting = ref(false)

  // 地址是可分享视图的事实源；读旧链接时不重写，也不碰频道/会话等其它参数。
  const sharedView = computed<Exclude<CenterView, 'inspector'>>(() => {
    const initView = route.query.view
    if (initView === 'sessions') return 'chat'
    return typeof initView === 'string' && VIEW_VALUES.has(initView)
      ? initView as Exclude<CenterView, 'inspector'>
      : 'chat'
  })
  watch(() => route.fullPath, () => {
    inspecting.value = false
  })

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
  const rightOpen = ref(false)
  /** 窄屏:左右侧栏都不再占位(收成覆盖式抽屉 / 并入切换条) */
  const applyTier = (desktop: boolean): void => {
    leftOpen.value = desktop
    // 对话优先:右侧检查器默认收起,把宽度让给阅读列;需要时一键展开
    rightOpen.value = false
    if (desktop) inspecting.value = false
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

  // 轨道、窄屏切换条、会话入口和命令面板共用这个写入口；replace 不刷屏也不堆历史。
  const view = computed<CenterView>({
    get: () => narrowUI.value && inspecting.value ? 'inspector' : sharedView.value,
    set: (next) => {
      if (next === 'inspector') {
        inspecting.value = narrowUI.value
        return
      }
      inspecting.value = false
      void router.replace({ path: route.path, hash: route.hash, query: { ...route.query, view: next } })
    },
  })
  const viewOptions = computed(() => {
    const base = [
      { value: 'timeline', label: t('wsView.k3otu32010') },
      { value: 'chat', label: t('wsView.chat') },
      { value: 'lanes', label: t('wsView.lanes') },
      { value: 'board', label: t('wsView.k3ko7a8011') },
      { value: 'split', label: t('wsView.k3xbmo012') },
      { value: 'town', label: t('wsView.k1cz0pbw013') },
    ]
    // 窄屏「一次一区」:检查器不占侧栏,并入切换条(四区都由同一条承载)
    return narrowUI.value ? [...base, { value: 'inspector', label: t('wsView.inspector') }] : base
  })
  const onViewKey = (ev: KeyboardEvent): void => {
    if (ev.defaultPrevented || ev.isComposing || ev.keyCode === 229 || ev.metaKey || ev.ctrlKey || ev.altKey) return
    const target = ev.target
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select, [role="combobox"]'))) return
    const next = VIEW_KEYS[ev.key]
    if (!next || !channelId.value) return
    ev.preventDefault()
    view.value = next
  }

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
