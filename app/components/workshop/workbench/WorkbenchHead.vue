<script setup lang="ts">
/**
 * 工作台页头(已登录态):kicker + 大标题 + 用户名描述 + 库链接行 + 新建 workspace 主 CTA。
 * 无状态展示件:用户名由页面传入,登出/新建只上报点击(弹窗开合由页面持有);
 * 库链接是纯导航,沿用全局 navigateTo(与拆分前同一批路径)。
 */
defineProps<{
  /** 当前登录用户名(userStore.user?.name;未登录时页面不渲染本组件) */
  userName?: string
}>()

/** 注意:必须把 defineEmits 的返回值赋给 emit —— 模板里的 `emit(...)` 才解析得到(setup 绑定) */
const emit = defineEmits<{
  logout: []
  newWorkspace: []
}>()
</script>

<template>
  <div class="aw-page-head">
    <div>
      <p class="aw-kicker">
        workshop / overview
      </p>
      <h1>Workshop {{ $t('wsHome.k3n4m5c025') }}</h1>
      <p class="sub">
        {{ userName }} {{ $t('wsHome.ke16e53026') }}
      </p>
    </div>
    <div class="head-acts">
      <div class="lib-links">
        <button
          type="button"
          class="lib-link"
          @click="navigateTo('/workshop/agents')"
        >
          {{ $t('wsHome.k3pa5h4013') }}
        </button>
        <button
          type="button"
          class="lib-link"
          @click="navigateTo('/workshop/teams')"
        >
          {{ $t('wsHome.k3svl8y014') }}
        </button>
        <button
          type="button"
          class="lib-link"
          @click="navigateTo('/workshop/channel-templates')"
        >
          Channel {{ $t('wsHome.k41ds5027') }}
        </button>
        <button
          type="button"
          class="lib-link"
          @click="navigateTo('/workshop/schedules')"
        >
          {{ $t('titles.schedules') }}
        </button>
        <button
          type="button"
          class="lib-link"
          @click="navigateTo('/tokens')"
        >
          API Token
        </button>
        <button
          type="button"
          class="lib-link"
          @click="emit('logout')"
        >
          {{ $t('wsHome.k484e7015') }}
        </button>
      </div>
      <button
        class="aw-pill im"
        @click="emit('newWorkspace')"
      >
        <span class="i-tabler-plus im-pop" />
        {{ $t('wsHome.newWs') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
/* 页头这一族的规则从 app/pages/workshop/index.vue 逐字搬来,包括
   @media 块排在 .lib-links 基础规则**之前**这个顺序 —— 两者同特异度(0,1,0),
   顺序决定了窄屏覆盖是生是死,不要"顺手"重排。
   .sub 在 AuthGate.vue 另有一份同样的拷贝给登录门描述用 —— 有意重复,不要合并成公共 css。 */
.sub { margin: 0 0 14px; font-size: 12.5px; color: var(--ink-faint); }

.head-acts {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-end;
}

/* 窄屏:页头已经纵向堆叠(见 main.css v5),这一组也必须改成"左对齐 + 按钮满行"。
 * 否则会出现"文字链居中、主按钮靠右"的错位 —— 两行不同对齐轴,读起来像两组东西(实测 /workshop)。 */
@media (max-width: 900px) {
  .head-acts {
    align-items: stretch;
    gap: 12px;
  }

  .lib-links {
    justify-content: flex-start;
    gap: 8px 16px;
  }
}

/* 库链接行:安静文字链(降噪,主 CTA 只剩一个) */
.lib-links { display: inline-flex; flex-wrap: wrap; gap: 2px 14px; justify-content: flex-end; }

.lib-link {
  padding: 2px 0;
  font-family: var(--font-body);
  font-size: 12.5px;
  color: var(--ink-faint);
  cursor: pointer;
  background: transparent;
  border: 0;
  transition: color var(--transition-fast);
}

.lib-link:hover { color: var(--ink); text-decoration: underline; text-underline-offset: 3px; }
</style>
