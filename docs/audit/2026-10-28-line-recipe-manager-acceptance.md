# 产线配方管理权(line-recipe)× 下发收窄 —— 验收报告

- 日期:2026-10-28
- 结论:**功能已实现,真机验收通过**(42/42;权限矩阵 52/52;全量回归全绿)
- 计划:`docs/plans/2026-10-28-line-recipe-manager-plan.md`
- 证据:
  - 真机:`docs/audit/evidence/2026-10-28-node-binding-3mode/report.json`(42/42 PASS)
  - 权限矩阵:`docs/audit/evidence/2026-10-28-node-binding-authz/report.json`(52/52 PASS)

---

## 一、交付语义(用户裁定落地)

三轨授权,配方管理与参数下发彻底分离:

| 授权 | 能力 |
|---|---|
| `kind='line-recipe'`(nodeId=产线 id) | **产线配方管理权**:该线**全部配方**(含未来新建)可 查看/新建/修改/回退;**不发参数** |
| `kind='dcw'`(nodeId=节点 id) | **点位写授权 + 下发收窄器**:绑了 dcw,下发只能覆盖这些点位 |
| `kind='recipe'`(nodeId=配方 id) | 单配方操作权(存量语义,零变化) |

**下发规则(用户裁定)**:没绑任何 DCW → 持配方级授权(单配方或产线管理权)默认可对配方**全部参数**下发(向下兼容);绑了 DCW → 下发覆盖集必须 ⊆ DCW 绑定面,部分覆盖即拒并点名缺失节点。

治理零豁免:四层限界、运行门、HITL 三层钳位、60s 联锁、逐参数 ACK、journal 账本、审批后复核、收回即失活全部照常。直写工具仍恒拒。

## 二、真机验收(生产构建隔离实例 + 真实 omp + LM Studio Qwen3.5-9B 32k)

场景:观察线(2 数采)+ 写入线(2 DCW,配方 A/B 双参数);观察/手动/自动三频道之外,新增第四频道「验收-配方管理员」——持有 `line-recipe`(writeLine,auto)+ 仅 `dcwA` 一个点位绑定。

| 断言组 | 结果 |
|---|---|
| 观察模式:只读分析、零写、无审批 | ✅ |
| 手动模式:HITL 卡人工批准 → 点位下发 60→62,设备回读=账本,版本不变 | ✅ |
| 自动模式:免批 → 点位下发 60→62,设备回读=账本 | ✅ |
| 同活动配方双 Agent 各写其点(不同批次归因) | ✅ |
| 配方 v2(56/64)→ 统一回退 v1(62→60 双点,ACK 全绿)→ v3,v1/v2 保留 | ✅ |
| 换配方 B 接管 DCW(A=52,B=64);点位绑定 Agent 无需新绑定继续 trial | ✅ |
| **管理权收窄**:未绑定节点 trial → 「下发被收窄…只能覆盖这些点位」;绑定点位内放行 | ✅ |
| **真实 Agent 凭管理权新建配方**(无单配方绑定,窗口内新增) | ✅ |
| 新配方开跑接管 DCW(=v1 定义值) | ✅ |
| **同一 Agent update 生成 v2(52→54)→ rollback 回 v1(v3=52/64)** | ✅ |
| 收回管理权后 recipe_update → 拒(需配方级授权) | ✅ |
| IDD 三插件启用/工具注册/后端 200,未启动分析 | ✅ |

管理权新建配方的版本轨迹(真机证据):`v1:[52,64] → v2:[54,64](Agent 修改) → v3:[52,64](Agent 回退)`。

## 三、权限矩阵 E2E(T11–T13 新增)

REST 建绑 `line-recipe`(首绑 manual + modeForced / confirm 切 auto / 只读用户 403)、管理权 update/rollback 无单配方绑定放行、无 dcw 全参数下发(向下兼容)、补绑 dcw 即收窄(未绑点拒/绑定点放行)、收窄不影响版本操作、工具注入面声明管理权、收回后 update 拒。共 52 断言全绿。

## 四、单测(新增 6 项,累计 16/16;全量 745/745)

管理权 update/rollback 全线放行、无 dcw 全参数下发、+dcw 收窄(版本操作不受影响)、单配方绑定向下兼容(无 dcw 全发/补绑即收窄)、`assertRecipeCreate` 管理权授权锚、撤销 line-recipe 在飞审批按拒收敛零写入、tool-verify 管理线配方参数入写面且配方外节点仍拒。

## 五、顺手修复

- `GET /agent-tools/approvals?agentId=&scope=history` 此前**忽略 agentId 过滤**(pending 分支有),按 Agent 查历史会看到其他 Agent 的审批——已修(两个 scope 口径一致)。

## 六、回归矩阵

| 门禁 | 结果 |
|---|---|
| lint / typecheck / docs:check / i18n:check / readme:lint | 全绿(docs 91/91) |
| `npm run test:unit` | **745/745** |
| 权限矩阵 E2E | **52/52** |
| 真机三模式+管理权 | **42/42** |
| 产线治理 `test:e2e-line` | **44/44** |
| 未跑 | 优化器 live / 模型闭环 / 注塑闭环 / 本体真机 / IDD 结果库(本轮范围外) |

## 七、说明与边界

- 本轮真机中曾观察到自动频道 lead 在无任务时自主发起限界内试验(绑定面内、四层限界、审批/账本齐全)——授权链正确;为使验收确定性,场景提示词已加「未收到任务时禁止自主发起任何下发」。
- 一轮失败源于 `.output` 构建产物不完整(两次构建竞态导致路由 chunk 缺失,ERR_MODULE_NOT_FOUND);清目录重建后消失,非代码缺陷。**教训:构建期间不要并发起第二个构建;真机验收前确认 `.output` 完整。**
- 管理权授予门槛与 dcw 写向绑定一致(产线 operate + 首绑 manual + confirm 切 auto);委派(`team_grant_nodes`)按 nodeId 天然支持。
- 设备为 mock:证明授权/下发/回读/账本链路,不等价于真实 PLC 工艺响应。
- 工作区由并行会话共享,本轮改动未提交(遵守不主动 commit 纪律)。

## 八、复现

```bash
# 权限矩阵(自起隔离 dev 实例)
node scripts/e2e-node-binding-authz.mjs

# 真机(需 LM Studio qwen3.5-9b-32k;自起生产构建隔离实例;约 25 分钟)
npm run build
node scripts/e2e-node-binding-3mode-real.mjs
```
