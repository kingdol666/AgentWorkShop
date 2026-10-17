# v0.7.66 发布验收报告(工具调用统一预检)

日期:2026-10-17 · 版本:0.7.66 · 判定:**PASS**

## 验收标准(先行定义)

| # | 指标 | 通过条件 |
|---|---|---|
| A1 | 参数形状 | 必填引用缺失/类型错误 → 结构化拒绝,文案说明该传什么 |
| A2 | 节点绑定 | 传入未绑定节点(尤其他线节点)→ 拒绝,且回执列出调用者绑定面 |
| A3 | 绑定内放行 | 绑定节点/频道绑线只读节点/绑定配方参数节点 → 正常进入 handler |
| A4 | 产线/配方引用 | line_id / recipe_id 越出可读面 → 拒绝;配方不存在的文案可区分 |
| A5 | 链式引用 | dataset/job/model/plan/scene 经谱系回溯,跨线且非本人创建 → 拒绝 |
| A6 | 可行动性 | 拒绝文案包含「你的绑定面 + 下一步」(找谁绑定/改传什么),Agent 可自我纠正 |
| A7 | 审计 | 授权性拒绝写 `audit_log(action=tool.call.denied)`;形状类拒绝不入册 |
| A8 | 零回归 | 全量单测全绿;绑定内调用与既有工具面不回归 |
| A9 | 发布物 | 构建成功;tarball 关键文件齐;全局安装后实例可启动、版本正确 |

## 结果

| # | 结果 | 证据 |
|---|---|---|
| A1 | PASS | 单测「形状:引用参数非字符串」;E2E E6 `dcw_journal` 无参 → 参数校验拒绝 |
| A2 | PASS | E2E E3/E5/E7:绑 1 号传 2 号(他线)→ 拒绝;同线未绑定 1b → 同样拒绝 |
| A3 | PASS | E2E E4/E9/E10:1 号正常返回;频道绑线后 1b 只读可查;A 线状态正常 |
| A4 | PASS | E2E E8/E11:line_status B 线拒绝;recipe_apply 他线配方拒绝;单测不存在的节点/配方文案区分 |
| A5 | PASS | 单测「链式:跨线数据集拒,本人数据集放行」(谱系解析 dataset/mine vs foreign) |
| A6 | PASS | E2E E3 回执逐字包含 `你的绑定节点:dn-7240c8fa` 与「请让用户或 lead …绑定该节点…或改用上述范围内的节点重试」 |
| A7 | PASS | E2E E12:ops-logs 查到 `tool.call.denied ≥3`;单测断言形状类拒绝不入册 |
| A8 | PASS | 全量单测 **219/219**(本轮新增 13 + 修复存量 tool-profile-observer 9);typecheck 通过 |
| A9 | PASS | build 成功(21.3 MB / gzip 5.15 MB);tarball 39 MB/3706 项含 `.output`/`mcp`/`bin`/prompts;全局安装后 health=200 `version=0.7.66`、setup-status=200、插件 7 装载 0 失败 |

## 关键证据:核心拒绝回执(E2E E3 逐字)

```
工具调用被拒(引用校验,daq_query):node_id = 「dn-b4a821d4」不在你的授权范围内
(节点「2号他线节点-tvwjlw」,归属产线 ln-33548092)。该节点不在你的绑定范围内。
你的绑定节点:dn-7240c8fa。如需访问,请让用户或 lead 在数字孪生界面为你绑定该节点
(可用 my_industrial_nodes 查看现有绑定);或改用上述范围内的节点重试。
```

## 门禁清单与命令

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck` | ✔ |
| 单测 | `npm run test:unit` | ✔ 219/219 |
| 改动文件 lint | `npx eslint <本轮文件>` | ✔ 0 错 |
| 文档一致性 | `node scripts/check-docs-sync.mjs` | ✔ 91/91 |
| 真实场景 E2E | `node tmp-e2e/tool-verify-node-scope-20261017.mjs` | ✔ 13/13 |
| 构建 | `npm run build` | ✔ |
| 构建产物冒烟 | `node tmp-e2e/_smoke-built-20261017.mjs` | ✔ health 200 / 预检代码在产物 |
| 打包 | `npm pack --pack-destination D:/tmp/aw-pack` | ✔ 39 MB / 3706 项 |
| 全局安装冒烟 | `node tmp-e2e/_smoke-global-20261017.mjs` | ✔ version 0.7.66 / setup 200 |

## 已知非本轮问题(如实披露)

- 仓库级 `npm run lint` 有 21 条报错,全部位于**并行会话**未提交的 `tmp-e2e/final-e2e-*`、`kb-*`、`plugin-*` 与 `server/plugins-builtin/diag-bridge/*`;本轮改动文件 lint 为 0。未改动/未提交他人文件。
- Mimosa 提交前扫描返回 `scanner_enobufs`(输出缓冲溢出),按兼容策略继续提交;本报告不构成对整个仓库的安全背书。

## 发布坐标

- 功能提交 `2b14379`、测试基础设施修复 `2106bdd`、版本提交 `5ed5c4e`
- tag `v0.7.66`;npm `agentworkshop@0.7.66`
