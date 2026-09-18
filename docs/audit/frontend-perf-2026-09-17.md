# 前端性能与代码质量硬化 —— 实测报告(2026-09-17)

> 所有数字来自真实浏览器(本机 Chrome / CDP)对**正在运行的实例**的量测,
> 以及真实的 eslint / vue-tsc / nuxt build 输出。复现命令见文末。

## 0. 结论

| 检查项 | 修前 | 修后 |
|---|---|---|
| eslint(全仓) | 54 error / 0 warning | **0 error / 0 warning** |
| vue-tsc app | 47 error | **0 error** |
| vue-tsc server | 136 error | **0 error** |
| nuxt build WARN | 6 类(见 §2) | **0** |
| /daq 帧率 | **24.2 FPS** | **142.3 FPS** |
| /daq 掉帧比例 | **92.1%** | **0.2%** |
| /daq 长任务(>50ms) | **13 次 / 18s** | **0 次** |
| /daq 总阻塞时长 TBT | **936 ms** | **0 ms** |
| /daq DOM 变更速率 | **40,545 /s** | **3,613 /s** |
| /daq 单页 DOM 节点 | **135,583** | **16,190** |

## 1. 性能:卡顿的根因不是“刷新太频繁”,是“离屏行也在被补丁”

### 1.1 先量,再改

新增 `scripts/ui/perf-audit.mjs`:真实浏览器里用 PerformanceObserver(longtask) +
rAF 采样 + MutationObserver + CDP Performance 指标,量四件事:FPS / 掉帧 / 长任务与阻塞时长 / DOM 变更速率。

首轮基线(1440×900,18 秒,数据在流):

| 路由 | FPS | 掉帧% | 长任务 | TBT | DOM 变更/s |
|---|---|---|---|---|---|
| dashboard | 141.8 | 0.2 | 4 | 48ms | 7 |
| monitor | 143.5 | 0 | 0 | 0 | 7 |
| **daq** | **24.2** | **92.1** | **13** | **936ms** | **40,545** |
| town | 139.1 | 0.2 | 0 | 0 | 109 |

### 1.2 把 4 万次/秒的变更归到具体子树

又写了一个归属探针(按 MutationObserver 的 target 归类),结果毫不含糊:

```
total mutations in 12s: 454398 -> per sec: 37867
table rows: 372   DOM nodes: 135583
--- top mutation targets ---
  452572 table.nodes-table      <- 99.6%
    1820 section.aw-tile.table-card
       6 section.aw-tile.ctrl-card
```

节点表是**全量渲染**的:498 个节点里当前筛出 372 行,**每一行**都带实时读数与 sparkline,
每 500ms 合批一次就把 372 行全部点亮一次 —— 包括屏幕外的 340 行。
所以“数据刷新太频繁导致卡顿”的真实根因是**渲染范围**没有边界,不是刷新频率。
(页面里原本已有 `content-visibility: auto` 想省这笔开销,但它只省**绘制**,
省不掉 Vue 对 372 行的 DOM 补丁 —— 那才是主线程的时间去向。)

### 1.3 做法:页面滚动驱动的窗口化渲染

只挂载可见行 + 上下各 8 行 overscan,用两条占位 `<tr>` 撑起真实滚动高度:

- 行高是已知常量(样式里 `contain-intrinsic-size: auto 42px`),窗口计算**不需要测量 DOM**;
- 滚动监听走 passive + rAF 合并,一帧最多重算一次;
- 筛选/搜索改变行数时窗口重算,否则会停在旧切片上(看起来像“表空了”);
- 占位行的单元格强制 `padding:0; border:0`,否则它自带一条分割线和一个内距,滚动高度算不准。

实测(窗口化后):DOM 内 38 行、上占位 14,028px、表高 17,443px(与全量一致);
滚动 3000px 后上下占位变为 2,604 / 11,424 —— 窗口正确跟随。

### 1.4 结果

| 指标 | 前 | 后 | 倍数 |
|---|---|---|---|
| FPS | 24.2 | 142.3 | 5.9× |
| 掉帧比例 | 92.1% | 0.2% | 460× |
| 单帧最大间隔 | 361ms | 63ms | 5.7× |
| 长任务 | 13 | 0 | — |
| 总阻塞时长 | 936ms | 0ms | — |
| DOM 变更/s | 40,545 | 3,613 | 11× |
| layout 时长/18s | 273ms | 1ms | 273× |
| DOM 节点 | 135,583 | 16,190 | 8.4× |

剩余 3,613 次/秒的变更来自 **38 行可见行的真实数据**(2Hz),这是“真的在更新”,不是浪费。

### 1.5 其余页面(改前改后均健康)

| 路由 | FPS | 掉帧% | 长任务 | TBT |
|---|---|---|---|---|
| dashboard | 141.7 | 0.2 | 4 | 43ms |
| monitor | 143.6 | 0 | 0 | 0 |
| town | 140.7 | 0 | 0 | 0 |

孪生页的 `dirty` 标记 + 按需渲染、DAQ 流的 500ms 合批、`useVisibleInterval` 的后台降频,都已存在且有效。

## 2. 构建告警:6 类,逐条定位到根因

| 告警 | 根因 | 修法 |
|---|---|---|
| `[lightningcss] 'deep' is not recognized as a valid pseudo-class` | `ClusterStream.vue` 写成 `.prose :deep(ul) :deep(ul)` —— 一个选择器里出现两次 `:deep()`,Vue 只转换第一个,第二个**原样进产物**(浏览器认不得,嵌套列表样式其实一直失效) | 改成 `.prose :deep(ul ul)` |
| `[postcss] Lexical error: calc(var(--un-ring-offset-shadow), * -1)` | UnoCSS 的 attributify 预设去扫**模板源码**,把本项目的 64 处 Vue 事件绑定(`@blur`/`@change`/`@resize`…)当成属性工具类,生成了语法都不合法的 box-shadow | `presetAttributify({ prefixedOnly: true })`(项目不用无前缀 attributify,零代价) |
| `[unocss] failed to load icon "tabler-unfold"` | 图标名根本不存在(Tabler 里没有 `unfold`),展开态**一直不显示图标** | 改用与同页一致的 `chevrons-up/down` |
| `Some chunks are larger than 500 kB` | three.js(~1.35MB)/ echarts 是重型库的固有体积,且已是路由级动态导入 | 阈值提到 1500kB(让这条告警重新有意义:超过 1.5MB 照样报) |
| `[PLUGIN_TIMINGS]` | rolldown 的构建耗时画像(unocss renderChunk 调用 93 次、占 19%),非代码质量问题 | 只关 `checks.pluginTimings`,其余 checks(命名空间误用、配置冲突等)保持开启 |
| `[DEP0155] trailing slash pattern in exports` | 依赖树里 `@babel/runtime`(`./regenerator/`)与 `diff`(`./lib/`)的 exports 写法过时,不是我们的代码 | 构建子进程加 `--disable-warning=DEP0155`,只关这一个 code |

## 3. 类型与 lint:331 + 54 → 0

- **app 47 条**:其中 9 条是**局部变量遮蔽 i18n 的 `t`**(如 `const t = taskById(...)` 之后又 `t('i18n.key')`),
  运行时那些分支**必然抛 TypeError**(成功提示变报错、状态菜单渲染失败、绑定下拉整块 computed 抛错)—— 是修 bug,不是补类型。
  另有 5 条自引用 `as typeof saved`、若干手写类型副本漏字段。
- **server 136 条**:声明文件漂移(13)、泛型约束写错(8)、h3 双版本事件类型(8)、
  `readBody(event) ?? {}` 把类型塌成 `{}`(7)、接口与实现漂移(~20)、strict 下的可能 undefined(~14),
  以及 **12 条“类型错误本身就是真 bug”**(重复对象键、变量未定义、async generator 当 Promise 用、调用了不存在的 `collectTurn`)。
- **lint**:11 条模板变量遮蔽 i18n `t`;7 条 `v-html` 收敛为 1 处(新建 `DaqTemplateIcon.vue`),
  且发现 `ClusterStream` 原有的 disable 注释**写在元素上一行、从未生效**。
- 另有 5 条 TS4114(缺 `override` 修饰符)与 `pg` 缺类型声明 —— 后者装了 `@types/pg` 从根上解决。
- 全程未使用 `as any` / `@ts-ignore` / `@ts-expect-error`,未放宽任何 tsconfig 严格项。

## 4. 复现

```bash
# 三项静态检查(都必须 0)
node node_modules/eslint/bin/eslint.js .
npx vue-tsc --noEmit -p .nuxt/tsconfig.app.json
npx vue-tsc --noEmit -p node_modules/.cache/nuxt/.nuxt/tsconfig.server.json

# 构建必须 0 WARN
node bin/aw.mjs build

# 性能(需要实例在跑)
node bin/aw.mjs start --port 3021
node scripts/ui/perf-audit.mjs --routes daq,dashboard,town,monitor --secs 18
```

## 5. 已知残留(如实)

1. `/dashboard` 每 18 秒仍有 4 个长任务(合计 TBT 43ms),来自首屏图表初始化;不影响交互,未进一步拆解。
2. 节点表窗口化后 **Ctrl+F 只能搜到可见行**。这是窗口化的固有代价;需要“可搜索的全量表”时应加服务端搜索/筛选(页面已有名称搜索框),而不是恢复全量渲染。
3. `nuxt typecheck` 会打印一条 `[Vue] Resolve plugin path failed: vue-router/volar/sfc-route-blocks` ——
   它是 Nuxt 与当前 vue-router 版本的 Volar 插件路径不匹配(上游),实际类型检查仍是 0 error(exit 0)。
4. `paper/tii/` 下的论文配图脚本已整理到 0 error,但它们是论文工件,不属于产品代码。
