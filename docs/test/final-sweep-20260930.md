# 终轮深度排障与全量回归(2026-09-30 下午)

## 结论

TP1~8 全量回归套件(**124 断言 0 挂**,治理全开环境)+ 量化目标 HITL 生产场景(目标达成并固化)全部通过。本轮抓出并修复 **2 个真逻辑问题**(均为上一轮 stepLimit 修复揭开的次生洞 + 一个长驻韧性缺口),已提交 `9d1d3cc`。

## 抓到并修复的问题

### ① 统一回退被「完全一致 409」拦死 PLC 恢复(真逻辑洞)
- **现象**:TP4 4.5d/4.6c 回退报「目标版本参数与当前完全一致,无需回退」,PLC 停在试验值不恢复。
- **根因**:昨天的 stepLimit 修复让回退不再丢字段 → 定义真一致时,`revertToVersion` 的同值守卫抛 409,**把统一回退(dispatch=true)的 PLC 整批恢复腿一起拦死**。昨天该用例能过,恰是旧 bug(丢 stepLimit 造成假性差异)掩盖了 this 缺口。
- **修复**:`revertToVersion(allowNoop)` — 定义已在目标态时原样返回,恢复照常执行;仅定义回退(无 dispatch)保留 409;回执区分「定义已在目标版本(未生成新版本)/已生成新版本」。

### ② 调度循环对「中止回合遗留的 SUBMITTED 根」无自愈(长驻韧性缺口)
- **现象**:量化目标场景中,lead 的 omp 子进程被本机间歇性进程杀手杀死(`supervise external cancel → abort`),已建的 SUBMITTED 根 18 分钟无任何重驱,直至 ROOT_TIMEOUT 判死。
- **根因**:`hasUnplannedLeadRoot` 的重试被 `activeRootId` 无条件排除——它指向的根已终态时,后续 SUBMITTED 根永远不重试;且 lead harness 重建(PROCESS_EXIT)不唤醒调度循环。
- **修复**:activeRootId 仅排除「仍活跃」的根;lead 重建即补调度唤醒(幂等)。

## 回归证据

| 套件 | 结果 |
|---|---|
| TP1 参数语义面/消歧 | 10/0 |
| TP2 四层限界 | 11/0 |
| TP3 写控治理(60s 间隔/单步限/保持窗/回退冷却/节拍豁免) | 18/0 |
| TP4 配方生命周期(trial/apply/update/两种回退/judge) | 29/0 |
| TP5 绑定与授权 | 22/0 |
| TP6 审计归因 | 13/0 |
| TP7 默认频道编排闭环 | 17/0 |
| TP8 模板升级(upsert)/实例化 | 4/0(真实重启后验证) |
| **合计** | **124/0** |

### 量化目标 HITL 生产场景(tg 轮)
- 目标:「温度调到 168±2℃ 并稳定保持」,HITL 门开,人工在线。
- 结果:**PLC 150→168 精确达标**;复测后 `recipe_update` 固化 **v1→v2(同 id)**;`recipe_apply` 整批下发;**三道人工裁决全批**(trial+apply×2);审计链 `recipe.update.agent`/`recipe.apply`/`approval.approve` 齐备;零越界拒绝;**PLC==固化定义**;六任务全 COMPLETED。
- 本轮 KB 异步沉淀未及落库即收口(该能力已在当日双插件链与多Channel并行轮各实证一次,文档真实入库可检索)。

## 排障教训(复现必读)

1. **`AW_BENCH_MODE=1` 会旁路 60s 间隔/单步限/保持窗**——TP 套件验证治理必须**不带**它;bench 相反必须带。两套执行卡环境互斥。
2. **`runtime-settings.json` 在配置根,不在 data/**:清库(wipe data)不会清运行时设置——他轮留下的 `security.recipeDispatchApproval=true` 会让 TP 套件的 trial 挂 180s HITL 门。prep 已显式钉住该开关。
3. **TP 套件对节奏敏感**:prep 的配方开跑、TP3.6 的节拍豁免 trial 都会占用水写锁/节拍窗——串联连跑需等锁(tp1 已内置等锁,tp4 已内置节拍等待)。
4. 本机存在**间歇性外部进程杀手**(杀 omp/node 子进程,无日志可循):平台侧已补自愈(见修复②);测试侧偶发「空文本 120s 超时」应先查该窗口。

## 产物
- 修复提交:`9d1d3cc`(回退 no-op 放行 + 调度自愈两处)
- 测试脚本:.e2e-tmp/lc-e2e(tp1 等锁、tp4 节拍等待、prep 显式钉 HITL 关);.e2e-tmp/omp-e2e/target-goal.mjs(量化目标场景)
