# Optimizer 收敛总计划实施验收报告

日期:2026-10-23。对象:`docs/plans/2026-10-23-optimizer-master-plan.md`(v4.1,五席四轮评审定稿)。
方式:全程真实仓储 + node:test 单测 + 隔离实例 live e2e(真实 HTTP + Chrome)+ 进程内 acceptance。

## 1. 结论

**总计划 SW0–SW5、SW7 全部实施完成并通过对应验收;SW6 完成两项(scipy×linear 分派矩阵 422、协议 1|2),其余四项(env-lease 跨进程、worker 协议 v2 solverRef 分派、发布冻结 IR、MD 成组)按计划属 M5a/M5b 独立大项,标注 partial 未实施,不阻塞主链。**

| 验收面 | 结果 | 证据 |
|---|---|---|
| 单元/集成测试 | **396/396**(新增 6 个测试文件 26 用例) | `npm run test:unit` |
| 进程内 acceptance | **67/67** | `docs/audit/evidence/2026-10-22-optimizer-process-model/acceptance.json` |
| live e2e(隔离实例+真实 HTTP+Chrome) | **90/90** | `docs/audit/evidence/2026-10-23-optimizer-live/report.json` |
| 质量门禁(lint/typecheck/unit/i18n/docs) | **ALL PASS** | `docs/audit/evidence/2026-10-22-optimizer-process-model/gates.json` |
| 文档一致性 | 91/91;设置基准 126/19/42/84 | `npm run docs:check` |

关键里程碑证据:live R1.19 显示 `rec=verified(已验证推荐)` —— **UQ 证据链端到端打通**(6-run fixture,val 校准/test 实证 conformal,建议首次真实达到 verified 状态),这是双驱动链从"不可用建议"到"可验证建议"的实质跨越。

## 2. 按工作流对照

### SW0 验收地基 — done
- `optimizer.crosscheck.tol`(1e-6)与 `aml.uq.freshDays`(7)入 schema(均 applies=live,基准 124→126/42/84);settings 访问器;config.yml;i18n zh/en;10 处文档计数同步。

### SW1 统一授权 — done
- 新 `optimization/access.ts`:`assertOptimizationAccess`(profile/spec/dataset/eligibility/experiment/train/binding/capabilities/run|recommendation|crosscheck|dispatch 九类资源;拒绝统一 403 `AUTHZ_DENIED` + 恰 1 条 `tool.call.denied` 审计;`canSeeProfile` 列表过滤;`recordConfigAction` 配置审计)。
- 修复 7 处现存越权面:profiles 列表跨用户泄露、profile/spec publish 无归属、eligibility 无产线校验、train 任意角色可提交、experiments 无 lineId 全量返回、binding 创建缺 manage。
- 验收:tests/optimizer-access.test.ts(跨用户 403+审计、404 不审计、配置审计恰 1 条)。

### SW2 数据真实性 — done
- `shared/units.ts` 唯一换算边界(scale=0/NaN → 422 `UNIT_CONTRACT_INVALID`);context.ts 与 dataset-builder 兜底删除。
- `migrateDualDriveColumns`(v30):`aml_datasets.lineage_verified`、`optimizer_recommendations.{dispatched_at,approval_id,initiator_user_id,dispatch_state}`(旧行回填 idle)、`optimizer_candidates.model_id`、`optimizer_profiles.problem_ir_hashes_json`、`process_model_eligibility.{dataset_id,dataset_hash}`。
- 逐 run confirmed-segment 谱系判定:版本不符的 run 被排除出数据集(不再被当前版本倒填);`lineage_verified=0` 模型 publish+solve 双门 422 `LEGACY_MODEL_REQUIRES_RETRAIN`。
- 验收:tests/optimizer-data-lineage.test.ts;live fixture 三个场景全部补 confirmed segment;acceptance `ds-acc` 显式 `lineageVerified=1`。

### SW3 UQ 证据 — done
- `uq-evidence.ts`:`computeBlockUq`(split_conformal ⌈(n+1)(1−α)⌉ rank / empirical_max ×1.25 + coverage=1 硬门;emit 条件 nTestRuns≥2 ∧ nUniqueTestSteps≥120);`coverageThreshold = max(0.8, 0.9−3√(0.09/nTestRuns))`(0.8 硬底防小样本塌缩);`inputDistance`(MV+CV 双偏移,σ≈0→∞,长度不符→null);`isUqFresh`。
- 两个训练器补算 **val 段 rollout 残差**(此前 val 段闲置),`uq` 写入工件(注册算 hash 前)。
- manager 删除 `uqEvidenceOf()` 双证据路径,`buildUqEvidence`(工件 uq + artifactHash 锚 + context 双偏移距离)单源进建议行;`classifyRecommendation` 按 D3 门 + OOD>3 + null 距离 fail-closed。
- 资格精确谱系:资格行携带 datasetId+hash,`latestForDataset` 按模型训练数据集查询;spec 强制 static_response horizonSteps=1。
- 验收:tests/optimizer-uq.test.ts 6 用例(双模式/emit 条件/0.8 硬底/双偏移/分类门/fresh)。

### SW4 候选互校 — done
- `optimizer_candidate_crosschecks` 表(row_hash = sha256 全证据列;FK CASCADE)。
- `crosscheck.service.ts`:D7 冻结快照回放(nodeId 重排/NaN→fail/steps 422)、D8 工件强等(替换→409)、D1 分母=工件 norm.y.std(缺失→not_applicable)、D6 最新一行派生 + 读时 stale 谓词、D25 比较对钉死(worker predicted vs predictor replay;import 边界测试)。
- REST `POST .../recommendations/:id/crosscheck`;`getRunStatus`/`optimizer_plan_get` 派生展示。
- 验收:tests/optimizer-uq-crosscheck.test.ts(spike <1e-9、1e-4 扰动→fail、import 边界、row_hash/stale 派生)。

### SW5 治理下发 — done
- spec MV `controlNodeId`(parse optional/publish+dispatch required + ∈配方参数面)。
- `dispatch.service.ts`:D11 body 防伪(证据字段→422,服务端落库回查构造);D13 建卡/批准双时刻重验(⑥ 当前 MV **模型单位**步限);D14 `dispatch_state` idle→dispatched→committed→executed/failed/cancelled/denied 原子状态机、三前缀(`recipe:`/`recipe-propose:`/`optimizer-recipe:`)在飞去重(批准排除自身)、启动对账(committed 无 execute 审计→failed,禁自动重放);D24 步限;D23 firstMove/modelFirstMove 双值。
- **单一咽喉** `decideOptimizerDispatch` 接入 `hitl/respond` 与 `approvals/:id/decide` 双入口;`tool-approvals` lineIdOf/锚/cancelPendingForBinding 扩 `optimizer-recipe:`;workshop 插件启动对账挂载。
- 验收:tests/optimizer-dispatch.test.ts 7 用例(门序/幂等锚/单一咽喉执行/漂移拒收敛/取消先赢/三前缀去重/状态机)。

### SW6 扩展 — partial(诚实标注)
- **done**:scipy_slsqp×linear_mpc_quadratic 发布期 422 `SOLVER_TEMPLATE_UNSUPPORTED`(分派矩阵,堵住运行时静默误派);SolverRequest/Response/EventFrame `protocolVersion: 1|2`;MD/feature 输入保持显式 422(此前已修)。
- **not-run(无返工依赖的独立大项)**:跨进程 `env-leases.sqlite`、worker 协议 v2 按 solverRef 分派 + 内置 SolverAdapter 注册、`compileProblemIRStructure` 发布冻结 IR、MD 成组支持(mdB/mdD)。这些按计划属 M5a/M5b,其前置(发布期 422、协议类型、显式拒绝)已在本轮落位。

### SW7 收尾 — done
- horizon 清理:`.AgentWorkShop/prompts/host-tools.json` optimizer_solve 移除 `horizon` 参数;`SolveOptions.horizon` 删除;guard 测试改为语义锁定(时域恒等于已发布问题)。
- live fixture:N_RUNS=6、valRatio/testRatio=0.4(2/2/2,empirical_max 路径)、三场景 confirmed segments;R1.19/R1.21/R3.6/U1.12/U1.13 改为证据驱动的二态断言。
- live 90/90:**R1.19 `rec=verified`** —— UQ 证据链首次端到端达到 verified。

## 3. 与计划的偏差(全部 fail-closed 方向)

| 偏差 | 原因 | 影响 |
|---|---|---|
| binding 创建加 `manage` 权限(计划未显式要求) | SW1 配置管理权/调用权分离的自然结论 | 普通成员不能再改绑,只能调用 |
| scipy+linear 从"允许"改"发布期 422" | D21 分派矩阵;旧行为运行时静默误派 OSQP | 新建此类 Profile 被拒;存量如遇重发布需改 osqp |
| 互校 verdict=pass 时 currentArtifactHash 为空视为 stale | D6 fail-closed(查不到模型 = 不可确认) | 无 false-positive dual |
| SW6 四项未实施 | 独立大项,本轮聚焦 M1–M4 主链 | 见 partial 清单;前置已落位 |

## 4. 复现命令

```
npm run test:unit            # 396/396
npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/acceptance-optimizer-process-model.ts  # 67/67
npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/e2e-optimizer-live.mjs                 # 90/90(需 dev server 未占端口;自带隔离实例)
node scripts/run-quality-gates.mjs  # ALL PASS
npm run lint && npm run typecheck && npm run docs:check && npm run i18n:check
```
