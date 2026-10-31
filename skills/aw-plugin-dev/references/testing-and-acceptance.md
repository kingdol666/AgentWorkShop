# 插件测试与导出验收

## 1. 测试分层

插件测试不要一上来就连平台;按“纯函数 → 装载 → 实机 → 导出”四层收敛,失败定位最快。

| 层 | 测什么 | 方式 |
| --- | --- | --- |
| L1 纯逻辑 | 解码器/处理器/换算/参数校验 | `node:test` + `tsx`,不依赖平台 |
| L2 结构 | manifest、settings、路由表、工具定义 | 导入插件模块做形态断言 |
| L3 装载 | 热重载、启停、驱动/工具出现在目录 | `aw_plugin_list` + REST 目录 |
| L4 实机 | 模拟端点 → 样本/帧 → 值/量/时间 | `verify-mirror.mjs` + 平台 API |
| L5 导出 | CSV/JSON/manifest 内容一致 | 行数/列名/时间戳/标签/对象键(sha256 自行计算) |

## 2. L1:纯函数单测

仓库用 `node:test` + `tsx`(带 `.nuxt/tsconfig.server.json` 与 `--test-force-exit`)。示例:

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { myDecode } from '../server/plugins/my-plugin/decode'

test('私有报文 → scalar', () => {
  assert.deepEqual(myDecode({ json: { payload: { t: 25.3 } } }), { kind: 'scalar', value: 25.3 })
})
test('缺字段抛错,不返回 0', () => {
  assert.throws(() => myDecode({ json: {} }), /payload\.t/)
})
```

覆盖:正常值、边界(0/负/NaN/超长)、缺字段、错误形态(数组当标量、字符串当数值)、超限(>4096 点/>10MB)。

## 3. L2:结构与契约

- `node scripts/test-plugin-lifecycle.mjs`:装载/启停/热重载生命周期。
- `npx tsx --tsconfig .nuxt/tsconfig.server.json --test --test-force-exit tests/plugin-governance.test.ts`:插件治理、路由、设置面。
- 自写结构断言时至少检查:
  - `name` 与目录一致;kebab-case;
  - `setup` 是函数;`client` 是相对路径;
  - `settings[].key` 合法且不重复;
  - 路由 method/path/handler 完整,path 无 `:param`;
  - 工具 `name/parameters/handler` 完整,`roles` 只含 `lead|worker`;
  - `ctx.kv` 是唯一状态落盘方式(不直接写插件目录)。

## 4. L3:热加载与生效

1. 放 project 级 `.AgentWorkShop/plugins/<name>/`;`aw_plugin_toggle { name, enabled:true }`。
2. `aw_plugin_list`:插件出现、`failures=[]`、`enabled=true`。
3. `GET /api/workshop/daq` 的 `drivers[]` 出现插件 kind(带 `plugin:true`);`configFields` 可用于建节点。
4. 路由:`GET /api/plugins/<name>/health` 返回预期。
5. 改一行可见行为(如 health 返回的版本号)→ 保存 → toggle → 再请求,确认变化。
6. `aw_plugin_toggle { enabled:false }` → 驱动/路由/工具消失;再 enable 恢复。

**不要用重启验证热加载**;重启只能证明“代码能跑”,不能证明“热加载生效”。

## 5. L4:实机镜像验收

前置:模拟端点已起、节点已指向模拟端点、采集总控 running(生产实例先问用户)。

```bash
node scripts/onboarding/verify-mirror.mjs --base http://127.0.0.1:3300 \
  --node dn-xxxx --kind scalar --expect '{"value":25.3,"tolerance":0.2}' --json
```

断言:

- 窗口内样本数 ≥ 期望(默认 1);
- 至少一个桶的 avg/min/max 命中期望值(容差);
- 时间戳单调且落在窗口;
- vector:点数/指标/首末点;image:`meta.objectKey`/MIME/宽高/内容字节。

失败先看节点 `lastError` 与驱动 `test()` 回包,不要先改插件;多数是端点/量纲/权限问题。

## 6. L5:导出正确性

“文件存在”不等于“导出正确”。逐项核对:

| 项 | 断言 |
| --- | --- |
| 值 | 导出字段值 = 构造值(容差内),不是 0/常量/上一批残留 |
| 量 | 行数/点数/帧数与采样周期、模板声明匹配 |
| 时间 | 时间戳在导出窗口内、单调;同报文多字段时间戳重合 |
| 标识 | `line_id/product_id/recipe_id/run_id` 与当前测试线/批次一致 |
| 对象 | 图像 `meta.objectKey` 可被 `frames/content` 取回,字节非空,MIME 正确 |
| 清单 | 行数/列名与 CSV 文件一致(DAQ manifest 不含 sha256/列名,需自行计算/核对);CSV 转义正确(RFC4180) |
| 空值 | 缺字段/设备离线时是空/跳过,不是伪造 0 |

把 `verify-mirror --json` 输出、节点 id、时间窗、期望值写进交接记录。

## 7. 安全与治理自检

- 出站只走 `ctx.http`,URL 仅 http/https;内网目标走显式白名单,不绕过 SSRF 守卫。
- 凭据只进 `secretRef`/env;不写源码/KV/日志;GET 视图里的 `******` 不回写。
- 数据库查询只用参数绑定;不拼接 SQL。
- 不解析 XML/HTML(平台解码器只做 JSON/字节);不做动态求值。
- 写路径必须走 DCW 网关/HITL/量程/步长;插件不得直写 PLC。
- 插件失败要可见:`sample/write` 抛错或 `ok:false`,不要吞。

## 8. builtin 插件

- builtin entry 会随状态文件重载;helper 模块可能被 ESM 缓存;有工作副本的保持字节一致,没有副本的(如 serial-bridge)直接改 builtin。
- 验证不生效时走维护窗口,不要在生产重启。
- 发布前跑 `docs/plugins.md` §十三清单;记录版本与变更点。

## 9. 验收报告模板

```md
# <plugin> 验收
- 实例: base / mode / home(生产附加,未重启)
- 测试线/节点: <id 列表>
- L1: <n> 单测通过
- L2: lifecycle / governance 通过
- L3: 热加载 toggle 前后行为差异(证据)
- L4: verify-mirror PASS(n/m),窗口/期望值
- L5: 导出值/量/时间/标识/对象/清单 六项
- 回滚: 停用插件 + 删除本次节点;既有资源未动
```
