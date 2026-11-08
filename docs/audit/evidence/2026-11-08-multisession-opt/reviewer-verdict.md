# 独立审查核签结论(2026-11-08-multisession-opt)

## 逐 Story 结论

**US-ENV: VERIFIED**(带备注)
证据文件内无专门的 AC1/AC2 断言，但审查人当场独立复验:`GET http://127.0.0.1:4001/api/health` 返回 `status=ok, workshop=ready`;`:4010 LISTENING (PID 63508)`。AC3 由两份证据的 S0-2(`dcw=4 daq=19 recipes=4 running=4/4`)支撑。AC4 双账号登录由 collab S0-1 支撑，B 账号 admin 权限由其成功执行 L1 评审/L2 签核(W1-s3/s5 等 status 200)间接证实(未显式记录 role 字段，轻微)。

**US-MS: VERIFIED**(带 1 条备注)
13 条 AC 全部有 pass=true 断言且 detail 实质：T1(workers=3 + lineId 回读相等判定)、T3(posts=5 bad= + 绑定行回读)、M1(两会话 4 clones 互斥)、M2(绑定面继承逐 kind 校验)、P1a/P1b(真实节点 id/时间窗/批次号)、W1a-d(HITL 卡 id、设备回执批次 rr-aba44、回读 target=228.32 final=228.30)、C1-C5(A=active/B=closed、enabled 0,0,0,0、404 拒绝、A 克隆与基础成员存活)。
备注(AC-P2):断言仅证明两会话 task 消息被各自 runtime 认领消费(`state !== 'pending'`,服务端 `markConsumed` 在回合执行后才落定，已核对 `server/services/workshop/db/message.repo.ts` 与 `agent-runtime/message.ts`),但未抓取回复文本，「回复非空」子句属推断而非直接证据；且 T2 步骤为硬编码 `true`。

**US-PRJ: VERIFIED**(带 1 条备注)
10 条 AC 全部有对应断言：J3(实例 Channel id + 真实台账 ar-402d9877)、J4/J7/J8(三级审批 status=approved、数据集 ds-mw79w8dr-gng6nf 380 行)、J5/W2-h、J6(真实错误码 + approvalId+64 位 digest + 回读 target=229.70 final=229.70)、J9(completed + 5 类审计事件 missing= 空，expect 列表非空)、J10(3 实例 Channel 各 1 会话行)。
备注(AC-J2):S2-1 的 pass 条件实际只校验 3 个工作项 id 存在，`deps=true` 是误导性 detail;dependsOn 链/routingPolicy=technical/plan 审批仅体现在创建 payload(multi-channel-project-collab-live.mjs 第 280/293/297 行)而未回读断言，plan 审批失败会被静默跳过。依赖链的功能性运转由下游证据间接佐证(W2-h/W3-h 的 handoff 注入、派发前 readiness 轮询)，但该条 AC 的直接断言强度不足。

**US-EVD: VERIFIED**
AC1:三份证据文件齐备，pass=20/69/3,fail 全 0,断言条数与文件内 results 实际条数逐一吻合(69 = 3+3+1+W1×18+W2×23+W3×17+S3×4,已程序化核对)。AC2:即本次审查。AC3:记忆归档见 `D:\codes\ABO\aw-mem-runtime\.omc\progress.txt`(92/92 全绿 + 坑位记录)。

## 抽查 4 条断言真实性

1. **W1d(target=228.32 final=228.30)— 真实可信**。数值链完全自洽：S0-3 stepLimit=2.8,W1c 记录当前值 230.00,230.00−0.6×2.8=228.32 与 target 精确吻合；final 228.30 非整值，符合一阶惯性模拟器特征；trial 回执含批次 rr-aba44、设备证实标记。下游 collab 的 W2 以 228.30 为现值续算 229.70,跨文件数值链闭合，伪造无法做到这种跨运行一致性。
2. **P2(consumedA/B=true)— 部分真实**。consumed 语义经服务端代码核实为消息被 omp runtime 认领且回合执行(非仅投递)，且 sent=200/200 为真实 HTTP 状态；但 detail 无任何模型回复文本，「真模型对话」的输出侧证据缺失(见上备注)。非伪造，是强度不足。
3. **W2-t0(PROJECT_WRITE_INTENT_REQUIRED)— 真实可信**。detail 为服务端治理层完整错误文案(错误码 + 补救指引 project_request_write_intent),脚本硬校验 `isError && text.includes(code)`;紧接的 W2-t1 返回含 64 位十六进制 digest 与 approvalId,前后因果连贯，非手写文本。
4. **W2-h(…W1 分析结论…已注入)— 真实可信**。断言 needle 为运行时生成的 W1 结论前 40 字符(含分钟级时间戳与真实线 id),经实例 root 工件 REST 全文检索匹配，25s 轮询未命中即 fail;实例 Channel 每轮新建，陈旧数据无法命中。

## 脚本假阳性风险结论

- `channel-template-multisession-live.mjs`:无吞错/漏 await(全链 await,main().catch → finish(false) 落 FAIL 证据)。风险点:(a) 第 184 行 T2 硬编码 `true`,PATCH/activate 响应被忽略;(b) P2 只验消息状态不验回复文本;(c) C3 以 `status>=400` 判过、detail text 为空 —— 已核实服务端 `invokeHostTool` 对 `enabled!==1` 恰好抛 404「agent 不存在或已停用」(manager/host-tools.ts:98),而同路由对存活克隆均 200,故 404 确为 WP2 周卫生效，风险可接受。均不构成恒真主断言。
- `instance-session-check.mjs`:干净。API 失败返回空数组会导向 fail 而非 pass,登录失败落 I0 fail,I3 要求全部实例 Channel 均有会话行，无假阳性路径。
- 附带核查的 `multi-channel-project-collab-live.mjs`:整体严谨(W2-t5/W3-t2 失败时「如实降级」记 false;S3-4 expect 列表非空)，唯一弱点即 S2-1(AC-J2)如上。

## 结论

三份证据共 92 条断言全部 pass=true,抽查与交叉核对未发现任何伪造迹象；时间线(+08:00 换算)、数值链(SP 228.32→228.30→229.70)、跨文件 id(pid=79d31858)完全自洽，且关键环境 claim 经审查人独立复验。存在 2 处断言强度备注(AC-P2 回复未留痕、AC-J2 直接断言空心)，均属监控力度问题而非证据造假，不影响验收结论成立。

VERDICT: APPROVED
