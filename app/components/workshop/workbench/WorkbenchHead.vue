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
        <ClientOnly>{{ userName }}</ClientOnly> {{ $t('wsHome.ke16e53026') }}
      </p>
    </div>
    <div class="head-acts">
      <nav
        class="lib-links"
        data-testid="lib-nav"
        :aria-label="$t('wsHome.libraryNav')"
      >
        <button
          type="button"
          class="lib-link"
          @click="navigateTo('/workshop/agents')"
        >
          <span
            class="i-tabler-template lib-icon"
            aria-hidden="true"
          />
          <span>{{ $t('wsHome.k3pa5h4013') }}</span>
        </button>
        <button
          type="button"
          class="lib-link"
          @click="navigateTo('/workshop/teams')"
        >
          <span
            class="i-tabler-users-group lib-icon"
            aria-hidden="true"
          />
          <span>{{ $t('wsHome.k3svl8y014') }}</span>
        </button>
        <button
          type="button"
          class="lib-link"
          @click="navigateTo('/workshop/channel-templates')"
        >
          <span
            class="i-tabler-layout-grid lib-icon"
            aria-hidden="true"
          />
          <span>Channel {{ $t('wsHome.k41ds5027') }}</span>
        </button>
        <button
          type="button"
          class="lib-link"
          @click="navigateTo('/workshop/schedules')"
        >
          <span
            class="i-tabler-clock-bolt lib-icon"
            aria-hidden="true"
          />
          <span>{{ $t('titles.schedules') }}</span>
        </button>
        <button
          type="button"
          class="lib-link"
          @click="navigateTo('/tokens')"
        >
          <span
            class="i-tabler-key lib-icon"
            aria-hidden="true"
          />
          <span>API Token</span>
        </button>
        <span
          class="lib-sep"
          aria-hidden="true"
        />
        <button
          type="button"
          class="lib-link is-danger"
          @click="emit('logout')"
        >
          <span
            class="i-tabler-logout lib-icon"
            aria-hidden="true"
          />
          <span>{{ $t('wsHome.k484e7015') }}</span>
        </button>
      </nav>
      <div class="head-cta">
        <!-- 项目中心：Project 层的前端入口（与"新建工作区"并置，工作台首页即可达） -->
        <button
          class="aw-pill outline im"
          data-testid="goto-projects"
          @click="navigateTo('/projects')"
        >
          <span class="i-tabler-briefcase im-pop" />
          项目中心
        </button>
        <button
          class="aw-pill im"
          @click="emit('newWorkspace')"
        >
          <span class="i-tabler-plus im-pop" />
          {{ $t('wsHome.newWs') }}
        </button>
      </div>
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

/* 主 CTA 行：项目中心（outline）+ 新建工作区（实心）并排，窄屏平分整行 */
.head-cta {
  display: flex;
  align-items: center;
  gap: 8px;
}

@media (max-width: 900px) {
  .head-cta {
    width: 100%;
  }

  .head-cta .aw-pill {
    flex: 1 1 0;
  }
}

/* 窄屏:页头已经纵向堆叠(见 main.css v5),这一组也必须改成"左对齐 + 按钮满行"。
 * 否则会出现"文字链居中、主按钮靠右"的错位 —— 两行不同对齐轴,读起来像两组东西(实测 /workshop)。 */
@media (max-width: 900px) {
  .head-acts {
    align-items: stretch;
    gap: 12px;
  }

  /* 提高一级特异度:本块排在基础规则之前,若同特异度会被后面的基础规则反覆盖 */
  .head-acts .lib-links {
    width: 100%;
    justify-content: flex-start;
  }
}

/* 库工具条:一处有边界的操作面(图标 + 文字 chip),与主 CTA 明确分层 */
.lib-links {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
  justify-content: flex-end;
  padding: 3px;
  background: var(--surface-card, var(--paper-raised));
  border: 1px solid var(--line);
  border-radius: 11px;
  box-shadow: 0 1px 2px rgb(15 23 42 / 4%);
}

.lib-link {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  min-height: 30px;
  padding: 0 9px;
  font-family: var(--font-body);
  font-size: 12.5px;
  font-weight: 550;
  line-height: 1;
  color: var(--ink-soft);
  white-space: nowrap;
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 8px;
  transition:
    color var(--transition-fast),
    background-color var(--transition-fast),
    transform var(--transition-fast);
}

.lib-icon {
  font-size: 14px;
  color: var(--ink-faint);
  transition: color var(--transition-fast);
}

.lib-link:hover {
  color: var(--ink);
  background: color-mix(in srgb, var(--ink) 6%, transparent);
}

.lib-link:hover .lib-icon { color: var(--accent); }

.lib-link:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.lib-link:active { transform: scale(0.98); }

.lib-link.is-danger { color: var(--tone-danger-dot); }
.lib-link.is-danger .lib-icon { color: currentColor; opacity: 0.75; }
.lib-link.is-danger:hover {
  color: var(--tone-danger-dot);
  background: var(--tone-danger-bg);
}

.lib-sep {
  width: 1px;
  height: 18px;
  margin: 0 2px;
  background: var(--line);
}

/* 手持命中区:chip 本身已 ≥30px 高,窄屏再补足 40px 触控高度 */
@media (pointer: coarse) {
  .lib-link {
    min-width: 40px;
    min-height: 40px;
    justify-content: center;
  }
}
</style>
