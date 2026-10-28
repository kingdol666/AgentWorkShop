# 真实产线上线就绪评估(五协议 × Agent 操控 × 断链 fail-closed)

- 日期:2026-10-28
- 结论:**软件链路可以上真机做试点**。五族真实协议(Modbus TCP / Modbus RTU / OPC UA / MQTT / HTTP)全部接通,四族写控由 Agent 身份一次性批量写穿并经设备侧/平台回读双证;断链时如实失败、恢复后自愈。
- 但**不等于"今天就能无人值守上线"**:S7 尚未实装、OPC UA/MQTT 的安全默认值需按现场配置、失败写会占用 60s 写入窗口、真实 PLC 硬件尚未接入验证。上线前须走完第六节清单。

---

## 一、本轮验证(21/21 PASS)

证据:`docs/audit/evidence/2026-10-28-golive-matrix/report.json`
脚本:`scripts/e2e-golive-matrix.mjs`

拓扑:隔离模拟器(真实协议栈,4036)+ 隔离平台实例(3419)+ omp/Qwen3.5 频道(manual 强制 HITL)。设备侧真值取模拟器 `/api/nodes` 的信号值,平台侧取 TSDB 样本/节点回读。

| 组 | 断言 | 结果 |
|---|---|---|
| S/P | 五协议设备端点在线;平台接入 5 DAQ + 4 DCW | ✅ |
| D | 五协议各 ≥15~29 点样本,且样本=设备侧信号(误差:TCP 0.39℃ / RTU 1 个 / OPC UA 0.18MPa / MQTT 1.4μm / HTTP 0.1‰) | ✅ 5/5 |
| W1 | 开线配方四协议写穿:设备侧 `[195,160,90,1.1]` = 配方基线 | ✅ |
| G0 | 四协议点位绑定 + manual 频道 + 最小工具面 | ✅ |
| W3 | **Agent 令牌四协议批量下发**:回执「4/4 全部设备证实」,设备侧 `[200,170,85,1.2]` | ✅ |
| W4 | 平台回读四协议 = 目标 | ✅ |
| N1 | 越量程写 300(>260)→ 400 `NODE_RANGE_EXCEEDED`,设备不变 | ✅ |
| N2 | 点位直写 +20(>单步 5)→ 409 `STEP_LIMIT_EXCEEDED`,设备不变 | ✅ |
| F1 | 停 OPC UA 设备 → 连接测试 `ok=false` + ECONNREFUSED 诊断 | ✅ |
| F2 | 断链写入 `ok=false`(错误分类),设备值不变 | ✅ |
| F3 | 恢复后连接测试 ok,写入成功 `readback-verified`(175/175) | ✅ |

补充:前一轮 `2026-10-28-physical-effect` 21/21 已证明**模型自主决策**下的下发(Modbus,设备寄存器直读 198→200,PV +2.71℃)。

## 二、能力边界(能不能上真机,分档说)

| 协议 | 读 | 写 | 上真机判断 |
|---|---|---|---|
| Modbus TCP | ✅ 真实驱动 | ✅ 回读证实 | **可试点**;核对寄存器表/字节序/单元号 |
| Modbus RTU-over-TCP | ✅ 真实驱动(CRC16) | ✅(走同一框架) | **可试点**;串口直连需 serial-bridge 插件,网关须透传 |
| OPC UA | ✅ | ✅ 回读证实 | **可试点**;生产必须配 Sign/SignAndEncrypt + 证书 |
| MQTT | ✅ | ✅(ACK 默认 transport-ack) | **可试点**;配 `readTopic` 才升到 readback-verified;TLS/账号必配 |
| HTTP REST | ✅ | ✅ POST 回读 | **可试点**;内网源需显式 `allowPrivateHost='true'`,凭据走 `{{SECRET:REF}}` |
| **Siemens S7** | ❌ 桩 | ❌ 桩 | **不可用**:`PlannedProtocolStub` 显式拒绝,需装 nodes7 并实现 poll |

## 三、本轮发现的问题(按影响排序)

| # | 级别 | 发现 | 影响 | 建议 |
|---|---|---|---|---|
| 1 | P1 | **失败写入也占用 60s 写入窗口**:`dcw-runtime.write` 在驱动调用前就写 `node.lastWriteAt`,断链失败后恢复,首个重写被 429 挡住(实测 11 次 429 后成功) | 现场瞬断恢复后需等约 60s 才能重写;UI 的"最近写入"会把失败尝试算进去 | 拆分「最近尝试」与「最近成功」:频控用尝试时间,展示/审计用成功时间;或失败时回滚 lastWriteAt |
| 2 | P1 | **S7 未实装** | 西门子 S7 产线无法接入 | 明确告知现场;需要时实现 nodes7 驱动 |
| 3 | P2 | OPC UA `securityMode` 缺省 None,生产仅告警不拒绝 | 真实产线可能裸连匿名/明文 | 上线策略:生产环境强制 SignAndEncrypt,None 直接拒绝 |
| 4 | P2 | DAQ 样本只在**批次运行中**持久化/打标 | 停线时看板上没有新样本,易被误判"采集坏了" | 运维口径写明;或增加"停线旁路采集"开关 |
| 5 | P2 | MQTT 写入默认 transport-ack | 默认只能证明 broker 受理,不能证明设备生效 | 现场配置 `stateTopic`/`readTopic` 升到 readback-verified |
| 6 | P2 | HTTP 驱动对旧配置 `legacyAllowPrivateWhenUnset=true` | 历史配置可在未显式白名单时访问内网 | 新线一律显式 `allowPrivateHost`,并纳入配置审查 |
| 7 | P3 | 外部对象存储时钟偏移时降级本地磁盘(本轮日志实测) | 图像/轮廓帧落本地,量产容量风险 | 现场必须 NTP 对时 + 对象存储连通性巡检 |

## 四、已验证的生产级机制

- **单一写入咽喉**:量程 ∩ 参数 ∩ 产品 ∩ 配方窗口四层取交集;manual/agent 直写另有单步限界 + 60s 间隔 + 写保持窗;配方下发走专用路径(边界=配方窗口,不套在线小步)。
- **HITL**:manual 频道全量挂审批;批准后执行点复核;审批可撤销。
- **ACK 如实分级**:readback-verified / transport-ack / unverified,失败不虚报。
- **账本与审计**:每次成功写入进 journal(prev/new/source/actor),节点 `lastWriteAt`、ops 日志、审批历史可追溯;回退有独立通道。
- **fail-closed**:设备断链 → 测试/写入返回具体诊断,设备值不变;恢复后自动重连。
- **Agent 最小面**:按绑定即时编译工具描述;写面预检点名未授权节点;observe 频道摘除写族。

## 五、真实硬件未验证项(必须现场确认)

1. 寄存器地址/数据类型/字节序(big/little/wordSwap)与真实 PLC 表一致;
2. RTU 网关是 mbap 还是 raw-rtu 透传;串口直连需插件;
3. OPC UA 命名空间/nodeId、证书信任链、账号权限;
4. MQTT broker 地址/TLS/账号,设备是否回显状态主题;
5. HTTP 接口鉴权方式与超时;
6. 网络:防火墙、静态路由、`NO_PROXY`、NTP;
7. 真实工艺响应时间与采样周期匹配(决定窗口/滞后参数);
8. 断网/断电/重启的现场演练与回退演练。

## 六、上线前清单(建议按序执行)

1. **试点一条线**:先只读(DAQ)跑 24h,核对样本与 PLC 面板值;
2. 配置量程/单步/配方窗口/写保持窗,做越界与超步负例;
3. 单点写 + 独立回读(PLC 面板或第二通道)验证 ACK;
4. 开 HITL,演练审批/拒绝/超时;
5. 断链演练:拔网线/停 PLC/停 broker,确认 fail-closed 与恢复;
6. 回退演练:recipe_rollback(dispatch=true)恢复到基线;
7. 安全加固:OPC UA SignAndEncrypt、MQTT TLS、HTTP 密钥引用、最小权限账号;
8. 再放开 Agent 工具面,从 observe → manual → auto 逐档放开;
9. 观测:采样滞后、写入 ACK 分布、审批时延、失败率告警。

## 七、复现

```bash
node scripts/e2e-golive-matrix.mjs
# 证据:docs/audit/evidence/2026-10-28-golive-matrix/report.json
```
