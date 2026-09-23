<script setup lang="ts">
import { message } from 'ant-design-vue'
import type { MenuProps, SelectProps } from 'ant-design-vue'
import type { AepHitlItem, AepHitlQuestion } from '#shared/workshop-protocol'
import { useUserStore } from '@/app/stores/workshop/user'
import { useWsConnectionStore } from '@/app/stores/workshop/connection'
import { useHitlStore, type HitlAnswerPayload } from '@/app/stores/workshop/hitl'
import { useChatStore } from '@/app/stores/workshop/chat'
import { useWorkshopWs } from '@/app/composables/workshop/useWorkshopWs'

const { t, locale, locales, setLocale } = useI18n()
const store = useAppStore()
const route = useRoute()
const trail = useRouteTrailStore()
const userStore = useUserStore()
const { metaFor } = useRouteMeta()

// ── HITL 全局待办(omp ask 对话框 + 各引擎原生提问/审批统一徽标;页头保底建连 ——
//    用户定向帧只达已连 peer,不建连的页面收不到提醒;快照兜底刷新前待办) ──
const hitl = useHitlStore()
const chat = useChatStore()
const wsSession = useWorkshopWs()
const ensureHitlLive = () => {
  if (userStore.isLoggedIn) wsSession.ensureConnected()
}
watch(() => userStore.token, (t2) => {
  if (t2) {
    ensureHitlLive()
    void hitl.loadSnapshot()
  }
  else hitl.clear()
}, { immediate: true })

/**
 * 可应答 kind 白名单(**与 server/api/workshop/hitl/respond.post.ts 的 RESPONDABLE_KINDS 一致**)。
 * 旧实现只对 codex/opencode/dsh 三种渲染按钮,且把 omp-dialog 排除在外 ——
 * omp 的 ask 对话框因此只能进终端面板回答,页头看不到任何入口。
 */
const HITL_KINDS: AepHitlItem['kind'][] = [
  'omp-dialog', 'dcw-approval', 'codex-approval', 'opencode-permission',
  'dsh-permission', 'claude-permission', 'qwen-permission', 'hermes-permission',
]
const hitlKindLabel = (kind: AepHitlItem['kind']) => {
  switch (kind) {
    case 'omp-dialog': return t('appHeader.hitlKindOmp')
    case 'dcw-approval': return t('appHeader.hitlKindDcw')
    case 'codex-approval': return t('appHeader.hitlKindCodex')
    case 'opencode-permission': return t('appHeader.hitlKindOpencode')
    case 'dsh-permission': return t('appHeader.hitlKindDsh')
    case 'claude-permission': return 'claude 权限'
    case 'qwen-permission': return 'qwen 权限'
    case 'hermes-permission': return 'hermes 权限'
    default: return kind
  }
}
const hitlGo = (item: AepHitlItem) => {
  navigateTo({ path: '/monitor', query: { agentId: item.agentId, channelId: item.channelId } })
}

// ===== 权限:能否审批由服务端能力视图决定(owner_only 时非 owner 不给控件) =====
// channelPermissionsOf 是唯一事实源;缺它的 channel 先拉一次(非成员也可调用)
watch(() => hitl.items.map(i => i.channelId).join('|'), (key) => {
  for (const cid of new Set(key.split('|').filter(Boolean))) {
    if (!(cid in chat.permissions)) void chat.loadPermissions(cid)
  }
}, { immediate: true })
const permsKnown = (item: AepHitlItem): boolean => item.channelId in chat.permissions
/**
 * 能否裁决:以服务端能力视图为准。
 * 例外:遗留无主 Channel(owner=NULL)的能力视图恒为 canApprove=false,但服务端
 * `hitl-decision.assertCanDecideHitlChannel` 对该类 Channel 保持旧口径
 * (getChannelForUser:任意登录用户可裁决,§13.2 兼容语义)—— 前端不能把服务端允许的
 * 操作藏起来,否则旧 Channel 的待办会变成"看得见、办不了"。
 */
const canAnswer = (item: AepHitlItem): boolean => {
  const p = chat.permissions[item.channelId]
  if (!p) return false
  if (p.canApprove || p.isAdmin) return true
  return chat.settings[item.channelId]?.legacy === true
}

// ===== 形态判定:requestType 优先(kind 推定兜底) =====
/**
 * 'question' = 答案是**内容**(自由文本/单选/多选/单选按钮组);
 * 'approval' = 答案是**是否放行**。
 * 现网各 adapter 尚未回填 requestType,故按 method 推定:select/input/editor 视为提问,
 * confirm(或缺省)视为授权 —— 与 adapter 的注册习惯一致(见各 agent registerHitl)。
 */
const requestTypeOf = (item: AepHitlItem): 'question' | 'approval' => {
  if (item.requestType) return item.requestType
  if (item.questions && item.questions.length > 0) return 'question'
  if (item.method === 'input' || item.method === 'editor' || item.method === 'select') return 'question'
  return 'approval'
}
const isQuestion = (item: AepHitlItem): boolean => requestTypeOf(item) === 'question'
/** opencode 权限支持引擎原生枚举(once/always/reject);其余引擎只认 confirmed 布尔 */
const isNativeOptionApproval = (item: AepHitlItem): boolean =>
  item.kind === 'opencode-permission' && (item.options?.length ?? 0) > 0

// ===== 答案草稿(按 item + 问题 id 分槽;切条目互不串) =====
const qSingle = ref<Record<string, string>>({})
const qMulti = ref<Record<string, string[]>>({})
const qFree = ref<Record<string, string>>({})
const itemKey = (item: AepHitlItem): string => `${item.kind}:${item.id}`
const slotOf = (item: AepHitlItem, qid: string): string => `${itemKey(item)}:${qid}`
const isChosen = (item: AepHitlItem, q: AepHitlQuestion, label: string): boolean =>
  q.multiSelect ? (qMulti.value[slotOf(item, q.id)] ?? []).includes(label) : qSingle.value[slotOf(item, q.id)] === label
const chooseOption = (item: AepHitlItem, q: AepHitlQuestion, label: string): void => {
  const slot = slotOf(item, q.id)
  if (q.multiSelect) {
    const cur = qMulti.value[slot] ?? []
    qMulti.value = { ...qMulti.value, [slot]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] }
  }
  else {
    qSingle.value = { ...qSingle.value, [slot]: label }
  }
}
/** 单问题答案:选项(多选以中文顿号连接)+ 补充自由文本 */
const answerOf = (item: AepHitlItem, q: AepHitlQuestion): string => {
  const slot = slotOf(item, q.id)
  const picked = q.multiSelect ? (qMulti.value[slot] ?? []) : [qSingle.value[slot] ?? ''].filter(Boolean)
  const free = (qFree.value[slot] ?? '').trim()
  return [...picked.filter(Boolean), free].filter(Boolean).join('、')
}

/** 无 questions 的提问型条目合成为单题(选项来自 item.options;无选项 = 自由文本) */
const PLAIN_QID = '__plain'
const questionsOf = (item: AepHitlItem): AepHitlQuestion[] => {
  if (item.questions && item.questions.length > 0) return item.questions
  const opts = item.options?.map(o => ({ label: o }))
  return [{
    id: PLAIN_QID,
    question: item.message || item.detail || item.title,
    options: opts,
    multiSelect: false,
    freeText: !(opts && opts.length > 0),
  }]
}

/**
 * 统一应答入口(单点收敛 loading / 409 / 403 语义)。
 * 多问题时 `value` = JSON 对象字符串(键 = 引擎问题 id,缺 id 用下标)—— 服务端
 * 各 adapter 自行解析;单问题/自由文本时 `value` = 纯文本答案。
 */
const answer = async (item: AepHitlItem, payload: HitlAnswerPayload): Promise<void> => {
  const out = await hitl.answer(item, payload)
  if (out.ok) {
    message.success('已提交')
    return
  }
  if (out.code === 'ALREADY_RESOLVED') message.warning('已被他人处理')
  else if (out.code === 'APPROVAL_FORBIDDEN') message.warning(out.message || '无审批权限(该 Channel 策略不允许你决策)')
  else message.error(out.message)
}

const submitQuestion = async (item: AepHitlItem): Promise<void> => {
  const qs = questionsOf(item)
  let value = ''
  if (qs.length === 1) {
    value = answerOf(item, qs[0]!)
  }
  else {
    const obj: Record<string, string> = {}
    qs.forEach((q, i) => {
      obj[q.id || String(i)] = answerOf(item, q)
    })
    value = JSON.stringify(obj)
  }
  if (!value) {
    message.warning('请先填写或选择答案')
    return
  }
  await answer(item, { value })
}
const submitApproval = async (item: AepHitlItem, confirmed: boolean): Promise<void> => {
  await answer(item, { confirmed })
}
const submitNativeOption = async (item: AepHitlItem, response: string): Promise<void> => {
  await answer(item, { response })
}
const submitCancel = async (item: AepHitlItem): Promise<void> => {
  await answer(item, { cancelled: true })
}
/** 审批策略人话(policy 由服务端冻结在条目上;缺省 = owner_only 语义) */
const policyLabel = (item: AepHitlItem): string =>
  item.policy === 'any_member' ? '任一成员可决策' : item.policy ? '仅 owner 可决策' : ''

/* 语言选择器在窄屏显示"短名":完整语言名(简体中文=56px @14px)配上
 * antd 给箭头预留的 24px 内距,92px 的选择器只剩 46px 文本位 ——
 * 实测被截成「简 体…」,这是每页都出现的破相。
 * 窄屏用 2 字标签,桌面保留完整语言名。 */
const localeOptions = computed(() =>
  (locales.value as Array<{ code: string, name: string }>).map(l => ({
    label: isMobile.value ? l.code.split('-')[0]!.toUpperCase() : l.name,
    value: l.code,
  })),
)

const switchLocale: SelectProps['onChange'] = (value) => {
  if (value != null) {
    // 持久化 + 强刷:setup 期求值的词条(脚本常量)只有重载才能整体切换
    // cookie 参与 SSR 首帧(locale-cookie.global.ts);localStorage 保留为插件回退
    useCookie('aw.locale', { maxAge: 60 * 60 * 24 * 365 }).value = String(value)
    localStorage.setItem('aw.locale', String(value))
    setLocale(String(value) as 'zh-CN' | 'en')
    window.location.reload()
  }
}

/* ── 响应式:窄屏顶栏不是"缩小版顶栏",而是换一套信息优先级 ─────────────
 * 桌面:航迹页签是主角(多页并行来回切)。
 * 窄屏:页签轨与右侧功能簇争抢横向空间 —— 实测 390px 下页签被右侧图标
 *       逐个压过去,最后连用户铭牌都被推出视口(顶栏 overflow:hidden 直接裁掉)。
 *       所以窄屏撤掉页签轨,用**当前页标题**替代:窄屏用户要的是"我在哪",
 *       不是"我刚才还开过哪 5 个页面"。 */
const { isDrawer, isMobile } = useResponsive()

const navToggleLabel = computed(() =>
  isDrawer.value
    ? (store.mobileNavOpen ? t('header.closeNav') : t('header.openNav'))
    : (store.sidebarCollapsed ? t('header.expand') : t('header.collapse')))

const toggleNav = () => {
  if (isDrawer.value) store.toggleMobileNav()
  else store.toggleSidebar()
}

const currentTitle = computed(() => metaFor(route.path).title)

// ── 航迹导航:路由变化 → 记录航点;切换时进度线扫过 ──
const hydrated = ref(false)
const plotting = ref(false)
let plotTimer: ReturnType<typeof setTimeout> | null = null

watch(() => route.path, () => {
  trail.visit(route.path)
  plotting.value = false
  requestAnimationFrame(() => {
    plotting.value = true
    if (plotTimer) clearTimeout(plotTimer)
    plotTimer = setTimeout(() => {
      plotting.value = false
    }, 620)
  })
}, { immediate: false })

onMounted(() => {
  hydrated.value = true
  trail.visit(route.path)
})

onBeforeUnmount(() => {
  if (plotTimer) clearTimeout(plotTimer)
})

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

const isFullscreen = ref(false)

function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen()
    isFullscreen.value = true
  }
  else {
    document.exitFullscreen()
    isFullscreen.value = false
  }
}

// 用户铭牌:真实身份(workshop 用户系统;未登录 = 访客)
const userInitial = computed(() => (userStore.user?.name ?? '?').trim().charAt(0).toUpperCase())
const userName = computed(() => userStore.user?.name ?? t('header.guest'))
const userRole = computed(() => (userStore.isLoggedIn ? userStore.user?.role ?? 'user' : 'anonymous'))

// ── 实时连接状态点(全局 WS 单例的诚实在线指示;断连不假装在线) ──
const conn = useWsConnectionStore()
const wsVisible = computed(() => conn.state !== 'closed' || conn.lastDataAt > 0)
const wsClass = computed(() => {
  if (conn.state === 'open') return conn.pendingReplay ? 'syncing' : 'live'
  if (conn.state === 'connecting') return 'syncing'
  return 'down'
})
const wsLabel = computed(() => {
  if (conn.state === 'open') return conn.pendingReplay ? t('appHeader.kwsdot0002') : t('appHeader.kwsdot0001')
  if (conn.state === 'connecting') return t('appHeader.kwsdot0003')
  return t('appHeader.kwsdot0004')
})

interface AvatarMenuEntry {
  key: string
  label: string
  icon?: string
  danger?: boolean
  divider?: boolean
}

const avatarItems = computed<AvatarMenuEntry[]>(() => {
  const items: AvatarMenuEntry[] = [
    { key: 'tokens', icon: 'i-tabler-key', label: t('menu.tokens') },
    { key: 'settings', icon: 'i-tabler-adjustments', label: t('menu.settings') },
  ]
  if (userStore.isLoggedIn) {
    items.push({ key: 'd-logout', label: '', divider: true })
    items.push({ key: 'logout', icon: 'i-tabler-logout', label: t('header.logout'), danger: true })
  }
  return items
})

const onAvatarMenu: MenuProps['onClick'] = async ({ key }) => {
  if (key === 'settings') {
    navigateTo('/settings')
  }
  else if (key === 'tokens') {
    navigateTo('/tokens')
  }
  else if (key === 'logout') {
    await userStore.logout()
    navigateTo('/workshop')
  }
}
</script>

<template>
  <a-layout-header
    class="app-header app-header-glass"
  >
    <!-- 左侧:折叠 + 航迹标绘轨 -->
    <div class="header-left">
      <button
        class="collapse-btn"
        :aria-label="navToggleLabel"
        :aria-expanded="isDrawer ? store.mobileNavOpen : !store.sidebarCollapsed"
        @click="toggleNav()"
      >
        <span class="i-tabler-menu-2" />
      </button>

      <!-- 窄屏:当前页标题(替代被撤掉的页签轨) -->
      <span class="mobile-title">{{ currentTitle }}</span>

      <span class="rail-mark i-tabler-route" />

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
    </div>

    <!-- 右侧:功能集群 -->
    <div class="header-right">
      <!-- 用户通知铃(@ 提及 / Agent 回复 / 审批;user-scoped 定向推送,补拉走 DB 游标) -->
      <ClientOnly>
        <workshop-notification-center />
      </ClientOnly>
      <!-- HITL 待办铃标(有待办才出现;下拉内联应答,或点条目进入运行时监控) -->
      <ClientOnly>
        <a-dropdown
          v-if="hitl.count > 0"
          placement="bottomRight"
        >
          <button
            class="icon-btn hitl-bell"
            :title="t('appHeader.hitlBadge')"
          >
            <span class="i-tabler-bell-ringing" />
            <span class="hitl-count">{{ hitl.count }}</span>
          </button>
          <template #overlay>
            <div class="hitl-menu">
              <div class="hitl-menu-title">
                {{ t('appHeader.hitlBadge') }} · {{ hitl.count }}
              </div>
              <div
                v-for="item in hitl.items"
                :key="`${item.kind}:${item.id}`"
                class="hitl-item"
              >
                <!-- 头部:点击进运行时监控(定位 agent/channel);应答控件在下方独立区域 -->
                <button
                  type="button"
                  class="hitl-item-head"
                  @click="hitlGo(item)"
                >
                  <span class="hitl-item-top">
                    <span class="hitl-item-agent">{{ item.agentName }}</span>
                    <span class="hitl-item-kind">{{ hitlKindLabel(item.kind) }}</span>
                    <span
                      v-if="item.requestType || isQuestion(item)"
                      class="hitl-item-reqtype"
                      :data-type="requestTypeOf(item)"
                    >{{ isQuestion(item) ? '提问' : '审批' }}</span>
                  </span>
                  <span class="hitl-item-title">{{ item.title }}</span>
                  <span
                    v-if="item.detail"
                    class="hitl-item-detail"
                  >{{ item.detail }}</span>
                  <span
                    v-if="item.message"
                    class="hitl-item-detail"
                  >{{ item.message }}</span>
                  <span
                    v-if="item.policy"
                    class="hitl-item-policy"
                  >
                    <span class="i-tabler-shield-lock" /> 策略:{{ policyLabel(item) }}
                  </span>
                </button>

                <!-- 应答控件:仅具备审批资格的调用者可见(服务端策略 owner_only/any_member) -->
                <div
                  v-if="!HITL_KINDS.includes(item.kind)"
                  class="hitl-answer-note"
                >
                  该类型待办需在对应引擎界面处理
                </div>
                <div
                  v-else-if="!permsKnown(item)"
                  class="hitl-answer-note"
                >
                  读取审批权限…
                </div>
                <div
                  v-else-if="!canAnswer(item)"
                  class="hitl-answer-note"
                >
                  无审批权限{{ item.policy ? `(${policyLabel(item)})` : '' }}
                </div>
                <div
                  v-else
                  class="hitl-answer"
                >
                  <!-- 提问型:有 questions 时逐题收集;否则单个自由文本/选项组 -->
                  <template v-if="isQuestion(item)">
                    <div
                      v-for="(q, qi) in questionsOf(item)"
                      :key="`${item.kind}:${item.id}:${q.id}:${qi}`"
                      class="hitl-q"
                    >
                      <div
                        v-if="item.questions && item.questions.length > 1"
                        class="hitl-q-title"
                      >
                        {{ qi + 1 }}. {{ q.header || q.question }}
                      </div>
                      <div
                        v-if="q.header && q.question"
                        class="hitl-q-desc"
                      >
                        {{ q.question }}
                      </div>
                      <div
                        v-if="q.options && q.options.length > 0"
                        class="hitl-opts"
                      >
                        <button
                          v-for="o in q.options"
                          :key="o.label"
                          type="button"
                          class="hitl-opt"
                          :class="{ on: isChosen(item, q, o.label) }"
                          :title="o.description || o.label"
                          @click="chooseOption(item, q, o.label)"
                        >
                          {{ o.label }}
                        </button>
                      </div>
                      <a-textarea
                        v-if="!(q.options && q.options.length > 0) || q.freeText"
                        v-model:value="qFree[slotOf(item, q.id)]"
                        :rows="2"
                        :placeholder="q.options && q.options.length > 0 ? '补充说明(可选)' : '输入答案'"
                      />
                    </div>
                    <div class="hitl-btns">
                      <a-button
                        size="small"
                        type="primary"
                        :loading="hitl.answering === `${item.kind}:${item.id}`"
                        @click="submitQuestion(item)"
                      >
                        提交答案
                      </a-button>
                      <a-button
                        size="small"
                        :disabled="hitl.answering === `${item.kind}:${item.id}`"
                        @click="submitCancel(item)"
                      >
                        取消请求
                      </a-button>
                    </div>
                  </template>

                  <!-- 授权型:批准/拒绝(引擎原生枚举的 kind 另给选项按钮) -->
                  <template v-else>
                    <div
                      v-if="isNativeOptionApproval(item)"
                      class="hitl-opts"
                    >
                      <button
                        v-for="o in item.options"
                        :key="o"
                        type="button"
                        class="hitl-opt"
                        @click="submitNativeOption(item, o)"
                      >
                        {{ o }}
                      </button>
                    </div>
                    <div class="hitl-btns">
                      <a-button
                        size="small"
                        type="primary"
                        :loading="hitl.answering === `${item.kind}:${item.id}`"
                        @click="submitApproval(item, true)"
                      >
                        {{ t('appHeader.hitlApprove') }}
                      </a-button>
                      <a-button
                        size="small"
                        danger
                        :disabled="hitl.answering === `${item.kind}:${item.id}`"
                        @click="submitApproval(item, false)"
                      >
                        {{ t('appHeader.hitlReject') }}
                      </a-button>
                      <a-button
                        size="small"
                        :disabled="hitl.answering === `${item.kind}:${item.id}`"
                        @click="submitCancel(item)"
                      >
                        取消
                      </a-button>
                    </div>
                  </template>
                </div>
              </div>
            </div>
          </template>
        </a-dropdown>
      </ClientOnly>
      <!-- 实时连接状态点(WS 会话全局单例;未用过 WS 的会话不显示) -->
      <span
        v-if="hydrated && wsVisible"
        class="ws-dot"
        :class="wsClass"
        :title="wsLabel"
      />
      <a-tooltip :title="t('header.fullscreen')">
        <button
          class="icon-btn hdr-fullscreen"
          @click="toggleFullscreen"
        >
          <span
            class="i-tabler-arrows-maximize"
            :class="{ hidden: isFullscreen }"
          />
          <span
            class="i-tabler-arrows-minimize"
            :class="{ hidden: !isFullscreen }"
          />
        </button>
      </a-tooltip>

      <a-select
        id="hdr-locale"
        :value="locale"
        size="middle"
        :options="localeOptions"
        class="lang-select"
        @change="switchLocale"
      />

      <a-tooltip :title="store.isDark ? t('common.light') : t('common.dark')">
        <button
          class="icon-btn"
          @click="store.toggleDark()"
        >
          <span
            class="i-tabler-sun-high"
            :class="{ hidden: store.isDark }"
          />
          <span
            class="i-tabler-moon-stars"
            :class="{ hidden: !store.isDark }"
          />
        </button>
      </a-tooltip>

      <a-dropdown>
        <div class="user-chip">
          <!-- 用户身份(session 异步解析)仅客户端可知:SSR 渲染中性占位,挂载后填充
               —— 消除 hydration mismatch(unhead dispose 噪音的根因) -->
          <ClientOnly>
            <span class="user-initial aw-avatar">{{ userInitial }}</span>
            <span class="user-meta">
              <span class="user-name">{{ userName }}</span>
              <span class="user-role">{{ userRole }}</span>
            </span>
            <template #fallback>
              <span class="user-initial aw-avatar">·</span>
              <span class="user-meta">
                <span class="user-name">·</span>
                <span class="user-role">·</span>
              </span>
            </template>
          </ClientOnly>
        </div>
        <template #overlay>
          <a-menu @click="onAvatarMenu">
            <template
              v-for="item in avatarItems"
              :key="item.key"
            >
              <a-menu-divider v-if="item.divider" />
              <a-menu-item
                v-else
                :key="item.key"
                :danger="item.danger"
              >
                <span
                  :class="item.icon"
                  class="mr-2"
                />
                {{ item.label }}
              </a-menu-item>
            </template>
          </a-menu>
        </template>
      </a-dropdown>
    </div>

    <!-- 绘图仪进度线:路由切换时自左向右扫过 -->
    <span
      class="plotter-line"
      :class="{ run: plotting }"
      aria-hidden="true"
    />
  </a-layout-header>
</template>

<style scoped>
.app-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: var(--app-header-h, 56px);
  padding: 0 20px 0 10px;
  overflow: hidden;
  border-bottom: 1px solid var(--divider-hair);
  transition: background 0.3s ease, border-color 0.3s ease;
}

/* 顶栏玻璃:透出极光画布;下缘发丝线 + 微暗渐变保对比
 * v4:与侧栏同属壳层材质(同一观察窗),底部内阴影替代原先的顶部渐变 —— 玻璃的"厚度"来自遮蔽而非压暗 */
.app-header-glass {
  position: sticky;
  top: 0;
  z-index: 30;
  background: var(--mat-chrome-bg);
  backdrop-filter: var(--vibrancy-chrome);
  border-bottom: 1px solid var(--glass-line);
  box-shadow: var(--glass-specular);
}

.header-left,
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

/* ── 航迹标绘轨 ── */
.rail-mark {
  flex: 0 0 auto;
  font-size: 15px;
  color: var(--ink-faint);
}

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

/* 路由切换进度线:墨色细扫过(替换原天青→蜜桃粉彩渐变,色锁:温灰下仅墨色动线) */
.plotter-line {
  position: absolute;
  bottom: -1px;
  left: 0;
  width: 100%;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--ink-fainter) 30%, var(--accent));
  opacity: 0;
  pointer-events: none;
  transform: scaleX(0);
  transform-origin: left center;
}

.plotter-line.run {
  animation: plot-sweep 0.6s cubic-bezier(0.3, 0.8, 0.4, 1) forwards;
}

@keyframes plot-sweep {
  0% {
    transform: scaleX(0);
    opacity: 0.9;
  }

  70% {
    opacity: 0.9;
  }

  100% {
    transform: scaleX(1);
    opacity: 0;
  }
}

/* 幽灵图标钮:无描边,悬停浮 surface(open-tag tp-close 声部) */
.collapse-btn,
.icon-btn {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  font-size: 16px;
  color: var(--app-text, var(--ink-soft));
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: var(--radius-panel-sm);
  transition:
    background var(--transition-fast),
    color var(--transition-fast),
    transform 160ms cubic-bezier(0.22, 1, 0.36, 1);
}

.collapse-btn:hover,
.icon-btn:hover {
  color: var(--ink);
  background: var(--paper-deep);
}

.collapse-btn:active,
.icon-btn:active {
  transform: scale(0.94);
}

.lang-select {
  width: 118px;
}

/* 语言选择器:令牌驱动(主题失配时 antd 兜底色会露白,这里显式钉死) */
.lang-select :deep(.ant-select-selector) {
  color: var(--app-text, var(--ink));
  background: transparent !important;
  border-color: var(--app-border, var(--line)) !important;
}

.lang-select :deep(.ant-select-arrow) {
  color: var(--app-text-secondary, var(--ink-faint));
}

/* 操作者铭牌:头像 + 双行 */
.user-chip {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 42px;
  margin-left: 4px;
  padding: 0 12px 0 8px;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: var(--radius-pill);
  transition: border-color 0.16s ease, background 0.16s ease;
}

.user-chip:hover {
  border-color: var(--line);
  background: var(--hover-tint);
}

.user-initial {
  width: 28px;
  height: 28px;
  font-size: 12px;
}

.user-meta {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}

.user-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--app-text, var(--ink));
  letter-spacing: 0.01em;
}

.user-role {
  font-family: var(--font-mono);
  /* 8.5px 是"看得见读不了"的下限之外(实测常驻被审计标红);
     角色是身份信息,不是装饰刻度,抬到 9.5px 仍保持铭牌声部 */
  font-size: 9.5px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--app-text-secondary, var(--ink-faint));
}

/* 移动端当前页标题:桌面不存在(那里有页签轨) */
.mobile-title {
  display: none;
  min-width: 0;
  overflow: hidden;
  font-size: 14px;
  font-weight: 600;
  color: var(--app-text, var(--ink));
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ══ 顶栏响应式:按信息优先级逐级卸载,而不是让它们互相挤压 ═══════════════
 * 卸载顺序(从最可省到最不可省):页签轨 → 全屏钮 → 用户双行铭牌 → 语言文字。
 * 留下的核心是:HITL 铃标(有待办必须看得见)、连接状态点、主题、语言、身份。 */
@media (max-width: 899px) {
  .rail-mark,
  .trail {
    display: none;
  }

  .mobile-title {
    display: block;
    margin-left: 2px;
  }

  .app-header {
    padding: 0 12px 0 8px;
  }
}

@media (max-width: 639px) {
  .hdr-fullscreen {
    display: none;
  }

  .user-chip {
    height: 38px;
    padding: 0 6px;
  }

  .user-meta {
    display: none;
  }

  /* 窄屏标签已换成 2 字符(ZH / EN),选择器只需容纳标签 + 箭头 + 内距 */
  .lang-select {
    width: 76px;
  }

  .lang-select :deep(.ant-select-selection-item) {
    padding-inline-end: 16px;
    font-size: 12.5px;
  }

  .header-left,
  .header-right {
    gap: 4px;
  }
}

.hidden {
  display: none;
}

/* 实时连接状态点(诚实在线:open=绿/syncing=琥珀呼吸/closed=红;reduced-motion 全局收敛) */
.ws-dot {
  flex: none;
  width: 8px;
  height: 8px;
  margin: 0 2px;
  border-radius: 50%;
  background: var(--tone-success-dot);
  box-shadow: 0 0 6px color-mix(in srgb, var(--tone-success-dot) 55%, transparent);
}
.ws-dot.syncing {
  background: var(--tone-warning-dot);
  box-shadow: 0 0 6px color-mix(in srgb, var(--tone-warning-dot) 55%, transparent);
  animation: ws-pulse 1.2s ease-in-out infinite;
}
.ws-dot.down {
  background: var(--tone-danger-dot);
  box-shadow: 0 0 6px color-mix(in srgb, var(--tone-danger-dot) 55%, transparent);
}
@keyframes ws-pulse {
  50% { opacity: 0.45; }
}

/* ── HITL 待办铃标(琥珀警示;角标数字极简,无装饰堆砌) ── */
.hitl-bell {
  position: relative;
  color: var(--tone-warning-dot, #d4a017);
}
.hitl-count {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 15px;
  height: 15px;
  padding: 0 4px;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 700;
  line-height: 15px;
  color: var(--on-accent, #fff);
  text-align: center;
  background: var(--tone-danger-dot, #e05252);
  border-radius: 8px;
}
.hitl-menu {
  min-width: 300px;
  max-width: 380px;
  max-height: 70vh;
  padding: 6px;
  overflow-y: auto;
  background: var(--paper, #fff);
  border: 1px solid var(--line);
  border-radius: var(--radius-panel-sm, 10px);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.14);
}
.hitl-menu-title {
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--ink-faint);
  border-bottom: 1px solid var(--line);
}
.hitl-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  margin-top: 4px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-panel-sm, 8px);
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.hitl-item:hover {
  background: var(--paper-deep);
  border-color: var(--line);
}
/* 头部是按钮(点击进运行时监控);应答控件在其下方独立成区,不触发跳转 */
.hitl-item-head {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 0;
  font-family: var(--font-body);
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: 0;
}
.hitl-item-top {
  display: flex;
  gap: 8px;
  align-items: baseline;
  justify-content: space-between;
}
.hitl-item-agent {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
}
.hitl-item-kind {
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.1em;
  color: var(--tone-warning-dot, #d4a017);
}
.hitl-item-reqtype {
  flex: none;
  padding: 0 5px;
  font-size: 9.5px;
  letter-spacing: 0.06em;
  color: var(--ink-faint);
  border: 1px solid var(--line);
  border-radius: var(--radius-chip);
}
.hitl-item-reqtype[data-type='question'] { color: var(--tone-info-dot, #3b82f6); border-color: color-mix(in srgb, var(--tone-info-dot, #3b82f6) 40%, transparent); }
.hitl-item-title {
  overflow: hidden;
  font-size: 12px;
  color: var(--ink-soft);
  text-overflow: ellipsis;
}
.hitl-item-detail {
  overflow: hidden;
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-faint);
  text-overflow: ellipsis;
}
.hitl-item-policy {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-size: 10px;
  color: var(--ink-fainter);
}
.hitl-answer-note {
  padding: 3px 0;
  font-size: 10.5px;
  color: var(--ink-fainter);
}
.hitl-answer {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px dashed var(--line);
}
.hitl-q {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.hitl-q-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--ink);
}
.hitl-q-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--ink-faint);
}
.hitl-opts {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}
.hitl-opt {
  padding: 3px 9px;
  font-family: var(--font-body);
  font-size: 11.5px;
  color: var(--ink-soft);
  cursor: pointer;
  background: var(--paper, #fff);
  border: 1px solid var(--line-strong, var(--line));
  border-radius: var(--radius-pill);
  transition: color var(--transition-fast), background var(--transition-fast), border-color var(--transition-fast);
}
.hitl-opt:hover { color: var(--ink); border-color: var(--ink-fainter); }
.hitl-opt.on {
  font-weight: 600;
  color: var(--on-accent, #fff);
  background: var(--accent, #2f2a26);
  border-color: var(--accent, #2f2a26);
}
.hitl-btns {
  display: flex;
  gap: 6px;
  margin-top: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .plotter-line.run {
    animation: none;
    opacity: 0;
  }

  .stamp-enter-active,
  .stamp-leave-active,
  .stamp-move {
    transition: none;
  }
}
</style>
