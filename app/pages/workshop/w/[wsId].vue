<script setup lang="ts">
/**
 * Workspace 主控台(ChatGPT 式应用框)页面壳 —— 只做编排:
 * 图标轨(视图位/⌘K/A2A)+ 左栏 Channel 会话侧栏 + 中央列(标题条 + 中部视图 +
 * 底部 Composer)+ 右侧上下文面板 + Agent/Task 双抽屉。
 *
 * 2026-11-07 控制台 ChatGPT 化:页面改挂裸 `console` 布局(脱离全局头部/侧栏),
 * 壳层整幅视口无边框卡;视图切换桌面期移入图标轨,窄屏仍由顶栏切换条承载。
 * 设计规格见 docs/plans/2026-11-07-chatgpt-console-design.md。
 *
 * 状态各归其主(页面私有 composable,见 ./composables/):
 *  - useWorkspaceAuth    登录守卫 + workspace 服务端加载;
 *  - useWorkspaceChannels wsId 路由作用域 / 聚焦 channel / 挂载 channel 的 WS 订阅
 *                        (全页唯一注册点:挂载 workspace 全部 channel 的订阅);
 *  - useWorkspaceShell   视口档位(窄屏形态)/ 侧栏折叠与宽度 / 中部视图切换与数字快捷键;
 *  - useWorkspacePanels  Agent/Task 抽屉与 ⌘K、A2A 开关(+ provide 'aw:open-agent')。
 *
 * 视图区块在 components/workshop/console/ 下 —— **绝不放进 pages/**:Nuxt 会把
 * pages 下任何 .vue 当路由。scoped 样式随标记进各组件自己的 <style scoped>。
 */
import { useResponsive } from '@/app/composables/useResponsive'
import ConsoleRail from '@/app/components/workshop/console/Rail.vue'
import ConsoleTopbar from '@/app/components/workshop/console/Topbar.vue'
import ConsoleLeftPane from '@/app/components/workshop/console/LeftPane.vue'
import ConsoleCenterPane from '@/app/components/workshop/console/CenterPane.vue'
import ConsoleRightPane from '@/app/components/workshop/console/RightPane.vue'
import ConsoleDock from '@/app/components/workshop/console/Dock.vue'
// composable 放在 app/pages/workshop/composables/(与 teams.vue 共用同一目录):
// 本页在 w/ 子目录下,故是 `../composables/…` 而不是 `./composables/…`
import { useWorkspaceAuth } from '../composables/useWorkspaceAuth'
import { useWorkspaceChannels } from '../composables/useWorkspaceChannels'
import { useWorkspaceShell } from '../composables/useWorkspaceShell'
import { useWorkspacePanels } from '../composables/useWorkspacePanels'

definePageMeta({ layout: 'console' })

// 视口档位(唯一判据;SSR 期返回桌面档)—— 注入 useWorkspaceShell,档位监听只此一份
const { isDesktop } = useResponsive()

// 用户守卫 + workspace 服务端加载(返回值当前只有 authReady 且无消费方,故不接收)
useWorkspaceAuth()

// 路由作用域 + 实时订阅(wsId 从 route.params 取,订阅在此链路注册一次)
const { wsId, workspace, channelId, loaded, conn, stateColor, lastSeq } = useWorkspaceChannels()

// 外壳:窄屏形态 / 侧栏折叠与宽度 / 视图切换(依赖 isDesktop 与 channelId)
const {
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
} = useWorkspaceShell(isDesktop, channelId)

// 覆盖层(抽屉 / ⌘K / A2A):活动条、中部画布、右栏三处入口在此汇聚成一份状态
const {
  agentDrawerOpen,
  agentDrawerId,
  taskDrawerOpen,
  taskDrawerId,
  paletteOpen,
  a2aDebugOpen,
  openAgent,
  openAgentInChannel,
  openTask,
} = useWorkspacePanels(wsId)

useHead({ title: () => `${workspace.value?.name ?? 'Workspace'} · AgentWorkShop` })
</script>

<template>
  <div
    class="harness"
    tabindex="-1"
    @keydown="onViewKey"
  >
    <div class="main">
      <!-- @提及悬停信息卡(文档级委托;时间线/lanes 全树生效) -->
      <workshop-mention-hover-card />

      <!-- 图标轨:桌面常驻;窄屏不渲染(顶栏切换条承载视图切换) -->
      <ConsoleRail
        v-if="!narrowUI"
        v-model:view="view"
        v-model:left-open="leftOpen"
        :channel-id="channelId"
        @open-a2a="a2aDebugOpen = true"
        @open-palette="paletteOpen = true"
      />

      <!-- 窄屏抽屉遮罩:点空白收起(不盖住底部 Composer,输入不被"锁在"抽屉后) -->
      <div
        v-if="narrowUI && leftOpen"
        class="drawer-scrim"
        @click="leftOpen = false"
      />
      <ConsoleLeftPane
        v-if="leftOpen"
        :ws-id="wsId"
        :channel-id="channelId"
        :left-width="leftWidth"
        :narrow="narrowUI"
        @open-agent="openAgentInChannel"
        @open-palette="paletteOpen = true"
        @open-session="view = 'sessions'"
      />
      <workshop-pane-splitter
        v-if="leftOpen && !narrowUI"
        :label="$t('wsView.k1fkfvra005')"
        @resize="resizeLeft"
        @reset="leftWidth = LEFT_W_DEFAULT"
      />

      <!-- 中央列:标题条 + 中部视图 + Composer(对话语义的主轴,ChatGPT 同构) -->
      <section class="center-col">
        <ConsoleTopbar
          v-model:view="view"
          v-model:left-open="leftOpen"
          v-model:right-open="rightOpen"
          :ws-name="workspace?.name"
          :channel-id="channelId"
          :view-options="viewOptions"
          :narrow="narrowUI"
          :state-color="stateColor"
          :conn-state="conn.state"
          :last-seq="lastSeq"
          @view-key="onViewKey"
          @open-a2a="a2aDebugOpen = true"
          @open-palette="paletteOpen = true"
        />
        <ConsoleCenterPane
          :ws-id="wsId"
          :channel-id="channelId"
          :view="view"
          :narrow="narrowUI"
          @open-task="openTask"
          @open-agent="openAgent"
        />
        <ConsoleDock
          v-if="channelId"
          v-model:view="view"
          v-model:agent-open="agentDrawerOpen"
          v-model:agent-id="agentDrawerId"
          v-model:task-open="taskDrawerOpen"
          v-model:task-id="taskDrawerId"
          v-model:palette-open="paletteOpen"
          v-model:a2a-open="a2aDebugOpen"
          :ws-id="wsId"
          :channel-id="channelId"
        />
      </section>

      <workshop-pane-splitter
        v-if="rightOpen && !narrowUI"
        :label="$t('wsView.kwqb0st006')"
        @resize="resizeRight"
        @reset="rightWidth = RIGHT_W_DEFAULT"
      />
      <ConsoleRightPane
        v-if="rightOpen && !narrowUI"
        :channel-id="channelId"
        :right-width="rightWidth"
        :loaded="loaded"
        :view="view"
        @open-agent="openAgent"
        @open-task="openTask"
      />
    </div>
  </div>
</template>

<style scoped>
.harness {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  min-height: 0;
  margin: 0;
  overflow: hidden;
  background: var(--chat-canvas);
}
.main {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
}
/* 中央列:标题条/画布/Composer 纵向主轴(与 ChatGPT 会话列同构) */
.center-col {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

/* ══════════════════════════════════════════════════════════════════════════
   窄屏形态 · 单通道示波器(≤1023px) —— 一次只看一路信号
   ──────────────────────────────────────────────────────────────────────────
   桌面是「三区应用框」:图标轨 + 会话侧栏 + 中央列(标题条/画布/Composer)
   + 可折叠右上下文。到了 ≤1023,画布只剩 ~460px,硬塞的结果是各区互相压扁。
   所以窄屏换一台仪器,而不是把应用框缩小:

     · 中部视图(时间线 / lanes / 任务板 / 检查器)→ 由顶栏切换条承载,
       一次只挂载一区,顶部切换条独占一行、可横扫;
     · 频道会话列表 → 覆盖式抽屉(点遮罩/Esc/选中频道收起),不再占位;
     · 图标轨不渲染(视图切换并入顶栏);拖拽分隔条隐藏;
     · 触摸目标 ≥40px、标签 ≥11.5px。

   本页只留「壳」这一份:整壳高度、定位上下文(.main)、遮罩、分隔条隐藏;
   顶栏 / 左栏 / 右栏各自的窄屏规则随标记在对应子组件的 scoped 块里
   (components/workshop/console/)。

   ⚠️ 断点数值与 main.css v5 / useResponsive.ts 一致(1024 = 三区应用框下限),
      此处不再引入新魔数。桌面(≥1024)样式完全不受影响。
   ══════════════════════════════════════════════════════════════════════════ */
@media (max-width: 1023.98px) {
  .main {
    position: relative;
  }

  .drawer-scrim {
    position: absolute;
    inset: 0;
    z-index: 25;
    background: color-mix(in srgb, var(--ink) 34%, transparent);
  }

  /* 窄屏没有第二栏可分宽度,拖拽条只会白占 9px */
  .pane-splitter {
    display: none;
  }
}
</style>
