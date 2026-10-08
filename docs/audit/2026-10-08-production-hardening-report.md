# 生产化加固轮报告:写控 ACK 鉴定层 + HITL 手动总闸(2026-10-08)

> 动机:TII 实验/全功能大考后核证的四项生产短板中,本轮根治两项——①下发"假成功"(mqtt=puback 即成功、http=2xx 即成功);②HITL 缺线级手动总闸与真人触达。plan 经讨论定稿(memory: aw-production-hardening-plan-2026-10-08),用户确认后实施。

## 交付总览

| 能力 | 语义 | 关键落点 |
|---|---|---|
| **P0-A 写控 ACK 鉴定** | `DcwWriteResult.ack` 三级:`readback-verified`(独立回读容差内)/`transport-ack`(仅链路受理)/`unverified`(无确认);`verifyRecipeWrite` 写后验证器(3×2s readNow 补验,env `AW_WRITE_VERIFY_ATTEMPTS/INTERVAL_MS` 可调)把链路受理升级为设备证实;批次 `run.ackSummary` 三段汇总;整包/试验/回退工具回执**有 unverified/failed 一律 isError** + 逐参数 [证实✓]/[未证实⚠] 标注 | `shared/dcw-protocol/line.ts` (WriteAckLevel/WriteVerifyOutcome) · `dcw/drivers/*`(7 驱动如实上报)· `dcw-controller/write-verify.ts`(新)· `actuation.ts`(归一+写历史+WS)· `recipes.ts`(writeRecipeParams 接验证 + applyRecipe 判定落账) |
| **判定审计 + error 分级** | 每次整批下发(REST/Agent/回退/开跑单一咽喉点)落 `recipe.dispatch.ack` 条目:failed≥1→`level=error`,仅 unverified→`warn`,全证实→`info`;error/warn 同时向该线 operate 授权用户定向告警 | `db/database/schema.ts`+`open.ts`(audit_log.level 列迁移)· `ops.repo.ts` · `ops/ops.ts` · `runtime/line-notify.ts`(新,user_line_grants 反查+notifyUser)· `user.repository.ts usersOfLine` |
| **P0-B HITL 手动总闸** | 线级 `controlMode`:'manual'(**缺省,fail-safe**)时 auto 绑定的全部配方写族动作强制挂人工审批;manual→auto 须显式 `confirm:true`(复用 binding-mode 纯函数守卫);新线缺省 manual,存量线读侧归一 manual | `shared/dcw-protocol/line.ts`(LineView/LineInput)· `dcw-line.repo.ts`(create/controlModeOf/update 守卫)· `agents/industrial/recipe-gate.ts`(hitlRequired ∥ lineManual)· `api/workshop/dcw/lines/[id].patch.ts` |
| **定向触达** | 审批单创建/50%+85% 升级提醒/hold 催办均定向该线 operate 用户(eventId 与频道通知同键,(recipient,eventId) 唯一键幂等去重) | `agents/tool-approvals.ts`(lineIdOf + notifyLineOperators) |
| **hold 超时模式** | `security.hitl_timeout_mode`:'reject'(缺省 fail-closed)/'hold'(手动生产语义:不自动拒、5min 周期催办;回合终止/解绑照旧收敛拒绝,无悬挂) | `settings.ts securityHitlTimeoutMode` · `shared/config/schema.json`(live 键)· `tool-approvals.ts request()` |
| **前端** | /logs 严重级筛选+⛔/⚠️ 徽标;线卡「手动/自动」模式标签;线编辑弹窗控制模式两段式确认(manual→auto 须点"仍要切换");hold 审批卡"等待人工裁决(不自动拒绝)"文案 | `LogsFilterCard/LogsEventTable` · `useLogsQuery/useOpsLog/ops-logs API` · `DcwLineCard/dcw-page.css` · `DcwEditLineModal` · `DcwParamApprovalCard/useDcwParamApprovals` |

## 验收证据(全部实机 3001 生产模式)

### ① 专项 e2e `tmp-e2e/hardening-ack-gate.mjs` —— **34/34 全绿**(七腿)
- **腿 A 线级总闸 API(4)**:新建线缺省 manual;manual→auto 无 confirm→400 MODE_CONFIRM_REQUIRED;带 confirm→auto;auto→manual 自由。
- **腿 B mock ACK 闭环(5)**:整批 apply 两参数 transport-ack→写后验证升级 verified(attempts=1);ackSummary verified=2;ops `recipe.dispatch.ack` level=info;写历史携带驱动级 ack。
- **腿 C mqtt 断链(3)**:ECONNREFUSED→ok=false+ack=unverified(不阻塞其余参数);ackSummary.failed=1;ops **level=error**(存在写入失败)。
- **腿 D mqtt 在线(4)**:puback 受理 ok=true 但 ack=transport-ack;无读通道补验 3 次→verdict=unverified(**不虚报成功**);ackSummary.unverified=1→ops **level=warn**。
- **腿 E 总闸+通知(6)**:manual 线拦截 auto 绑定 recipe_apply 挂卡;线域运营者(operate grant)收到 hitl_request 定向通知;批准后 6/6 参数**设备证实**(modbus 回读);拒绝路径人工意见"先不要下发"逐字回流。
- **腿 F 总闸解除(3)**:线 confirm→auto + 绑定 confirm→auto → 免批直执行(无审批卡,6/6 设备证实)。
- **腿 G hold(5)**:设置热更→卡 expiresAt 空、不自动拒(4s 后仍 pending)、人工批准正常执行;恢复 reject。

### ② api-full-loop —— **53/53 全绿**(新增 ⑥b 段 9 断言)
ackSummary/ack 字段/`recipe.dispatch.ack` 落账/controlMode 归一与 confirm 守卫;既有 44 断言(含防爆破锁定)无回归。

### ③ 一键基准 PIPELINE —— **92/92 全绿**(`docs/benchmarks/benchmark-20261008045434`)
S0 新增基准线总闸自适应(harness 显式 confirm 切 auto);S4 新增「ACK 鉴定:holdP 写入设备证实(readback-verified)」与「整批汇总全绿(ackSummary)」断言;S4 闭环 62→64 有界激励步、三方核验通过;S5 频控拦截/窗后回退;S6 规格内占比 100%(673 样本 mean 32.506 σ0.05)。S4 首跑 87/88 的唯一失败为管线自身成功正则未跟上新回执文案("已获批准"),修正后复跑 92/92。

### ④ GUI 实机冒烟(IAB 真浏览器,截图存档)
- /logs:严重级下拉(⛔ error(失败))过滤生效,结果行红徽标 + `recipe.dispatch.ack` 摘要可见。
- /dcw:线卡「自动/手动」模式标签与悬停语义正确(注塑一线=自动,测试线=手动)。

### ⑤ 质量门
typecheck ✔ · scoped eslint ✔(0 错)· docs:check **91/91**(新设置键入册后 8 文档计数同步 117→118/39→40;修复 BANNED 正则 "18 个设置项" 对 "118" 的子串误伤,加数字边界)。

## 本轮修复的自身缺陷(自省记录)
1. `write-verify.ts` env 守卫 `Number(process.env.X ?? '')<=0` 在未配置时恒真→验证器整体旁路(mock 线 B1 首跑 unverified at=0 的根因)。改为仅在显式配置≤0 时旁路。
2. e2e 数据路径两处(`data.logs`/`data.history`)与 ops 用户 id 提取(登录 early-return 未带 user.id)。
3. F2 腿首跑卡 306s:worker 配方绑定本身 manual(任何线都挂审批,30min 窗被回合看门狗 300s 收敛)——语义正确,测试设计改为显式 confirm 切 auto 再验免批。
4. settings 键未注册 schema→"未知设置项";补 `security.hitl_timeout_mode` 描述符 + 双语 labelKey。

## 生产部署语义(重要)
- **新装/存量线全部缺省 manual**:升级后 auto 绑定不再免批,运营者需显式 confirm 切 auto(宁多批一次,不可漏批一次)。基准线在 PIPELINE S0 自动声明 auto(harness 自动化环境)。
- 驱动选择建议:要求"参数真实生效"强保证的回路用 modbus/opcua(驱动内回读);mqtt/http 线的写现在会如实报"未证实"并由验证器/告警兜底。
- P1 遗留:审批离线外呼(webhook/邮件)、四眼原则、benchmark S8(AML 腿)/S9(混沌腿)、驱动契约测试套件。P2:真机 HIL 指南、多实例 HA(sqlite→postgres)。

## 变更清单(commit 待填)
代码 30 文件:协议 3(line/recipe/index)+ 驱动 7 + 控制器 4(actuation/recipes/write-verify/lines)+ repo 4(line/recipe-op/user/ops.repo)+ db 3(schema/open/rows 无涉)+ 服务 4(ops/settings/tool-approvals/recipe-gate)+ 工具 4(recipe-propose/ops-tools/param-tools 无涉/dcw-tools)+ 通知 1(line-notify)+ API 3(lines.patch/ops-logs/hitl 无涉)+ 前端 10 + 测试 3(hardening e2e/api-full-loop/run-benchmark)+ 文档 12。
