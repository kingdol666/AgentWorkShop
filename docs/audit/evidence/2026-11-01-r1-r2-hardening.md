# R-1/R-2 生命周期增强:根因 → 修复 → 升级论证(hardening)

**时间**:2026-11-01 · 基线 da627d21 + 本轮修改 · 目标:两处 A− 缺口修复至 A

---

## 0. 一句话结论

**R-1/R-2 已修复并以新单测锁定:R-1 dispose 后台化(卸载与全站活性彻底解耦),R-2 元数据变更清退避+死连接驱逐+即刻对账(热修配置不再依赖重建节点)。修复过程还修正了上轮对 R-2 的归因:退避只有 5s 且回收时已清,真正卡死热修的是 mqttPool 僵尸条目永不驱逐。** 类型/lint/专项单测 3/3 全过;全量单测 918 项(基线 913+新增 3+桥生命周期 2 项文案更新)回归中。

## 1. R-1:AgentRuntime 卸载阻塞事件循环 → A

### 1.1 根因链(源码级,全部钉死)
```
stop() 同步链:abort → mailbox.close → 广播
  → await Promise.race(loopPromise, 10s)      ← 宽限最长 10s
  → await impl.dispose()                      ← omp client 内含 ≤3s SIGKILL 等待
调用方(HTTP 管理动作/D1 兜底/实例删除)在整个窗口被占住
+ 事件循环繁忙(渲染/采样/写) → 健康探针 3×3s 无响应
→ scripts/start.mjs 守护判僵死 → SIGKILL 整个服务进程
= "卸载一个 agent" 演化为 "全站活性风险"(实测 #2→#11 连锁重启)
```

### 1.2 修复(lifecycle.ts)
- stop() 只做**同步可完成部分**:审批收敛→abort→mailbox.close→stopped 广播→立墓碑,**立即返回**
- 新增 `disposeInBackground()`:宽限 race(≤10s)→impl.dispose→finally 二次广播 stopped;全程容错,失败仅记日志
- 效果:**卸载窗口从"最长 13s 占住调用方"降为 0**(收尾与调用方完全解耦);守护探针再也看不到"卸载引起的活性空洞"

### 1.3 升级论证(A− → A)
- 原 A− 主因"卸载=全站活性风险"结构性消除(不再依赖守护的 3 次容忍)
- 残余风险评估:后台收尾失败仅损失该实例的子进程清理(下次重建 spawn 会覆盖),无全站影响
- 新单测锁定:**stop() 立即返回(dispose 移交后台)+dispose 抛错不冒泡** 两断言

## 2. R-2:DAQ 推送订阅热修配置依赖重建节点 → A

### 2.1 根因链(修正上轮归因)
- 上轮判断"pushRetryAt 退避跨 driverConfig 变更存续"**部分正确但非主因**:退避仅固定 5s 且 stopPushBinding 已会清它
- 真根因(mqtt.ts 全链走读):**mqttPool 条目永不驱逐**(mqttPool.delete 全文件 0 处)——broker 长期死亡后,池内连接进入僵尸态(mqtt.js 重连循环不再推进,connected 恒 false),节点侧每次订阅 `!conn.connected` 快速失败;**修好 endpoint 后,僵尸连接不重建,只能重建节点**(整条订阅随新节点全新建连)
- 叠加:PATch driverConfig 不清退避、不触发即时对账(要等 250ms 扫描,而扫描又被退避门槛挡住)

### 2.2 修复(四文件协作,沿用 contracts 跨层契约模式)
| 文件 | 变更 |
| --- | --- |
| daq-controller/contracts.ts | 新增跨层抽象 `daqPushRearm(nodeId)`(编译期校验,由 push.ts 实现) |
| daq-controller/crud.ts | PATCH driverConfig → `driverConfigChanged` 标志 → 调 `daqPushRearm(id)` |
| daq-controller/push.ts | 实现 daqPushRearm:清退避 → stopPushBinding(回收旧订阅)→ **驱逐僵尸池连接** → 立即 syncPushBindings(不等 250ms) |
| drivers/shared.ts + mqtt.ts | DaqDriver 新可选 `evictPoolConn(cfg)`;mqtt 实现 `evictMqttPoolConn`:**只驱逐未连接的僵尸条目,健康连接绝不碰**(不影响共享 broker 的其他节点) |

### 2.3 升级论证(A− → A)
- 原 A− 主因"热修必须重建节点"结构性消除:改配置=清退避+全新建连,即刻生效
- 驱逐的安全性:**健康连接绝不驱逐**(共享 broker 的其他节点零影响)+驱逐失败不阻断(退避已清,窗后自然重试)
- 新单测锁定:僵尸条目驱逐/健康条目保留 两断言

## 3. 顺带修复(被新单测暴露的既有漂移)
- `.AgentWorkShop/plugins/` 影子副本与 builtin 真身漂移(CRLF 污染+滞后):已从真身全量复制对齐;双副本一致测试 A1.14 复绿
- rag-bridge-lifecycle sync 成功文案断言随 2.2.0 新契约更新(✅ 前缀=等待到终态的显式标记)

## 4. 验收

| 项 | 结果 |
| --- | --- |
| 类型(tsc server) | 0 错误 |
| eslint(6 改动文件) | 0 |
| 专项新单测 tests/lifecycle-r1-r2.test.ts | **3/3**(挂起不阻塞/dispose 容错/僵尸驱逐+健康保护) |
| 桥生命周期测试 | 6/6 |
| 全量单测 | 918 项回归(运行中,含 3 新增) |
| 行为链推演 | D1 兜底 unloadAgent→stopAndDetach 立即返回→重组即刻开始(旧:占 13s);PATCH topic→rearm 清退避→驱逐僵尸→本拍重建订阅(旧:等退避+僵尸连接卡死) |

*改动文件:runtime/agent-runtime/lifecycle.ts · daq/daq-controller/{contracts,crud,push}.ts · daq/drivers/{mqtt,shared}.ts · tests/lifecycle-r1-r2.test.ts(新增)· tests/rag-bridge-lifecycle.test.ts(文案)· .AgentWorkShop/plugins 影子同步。*
