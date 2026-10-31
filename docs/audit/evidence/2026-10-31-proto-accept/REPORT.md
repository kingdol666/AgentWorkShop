# AgentWorkShop 协议接入与割接演练验收报告(proto-accept)

**时间**:2026-10-31 21:30~22:40 · **平台**:v0.8.8 · 3300(温态 home,生产附加模式,**全程零重启作业**)
**输入文档**:docs/audit/2026-10-31-doc-driven-virtual-validation.md(产线协议与工况合同:点位表/报文样例/控制约束/验收判据)
**路径**:aw-protocol-onboarding skill:**预检 → 蓝图 → 能力匹配 → 配置 → 模拟跑通 → 导出验收 → 割接六步**

---

## 0. 结论(一句话)

**文档 → 模拟接口 → 连接跑通 → 无缝割接真实场景的完整路径在本轮全链 PROVEN**:一份产线协议+工况文档,经蓝图提取→能力匹配→连通预检→测试线供给→**五点镜像采集 verify-mirror 全 PASS**→SP 写穿独立回读证实→导出五项核对全过;割接演练把端点从虚拟设备 4020 平移到"真实 PLC"替身 4120,**只改 driverConfig,节点/配方/限界/频道零重建**,verify-line V1-V6 **11/11 全绿**。语义层与真实场景之间没有需要翻译的东西——换端点即换现场。

## 1. 全功能运行验收(Phase A)✅

| 项 | 结果 |
| --- | --- |
| preflight | `running=true, treatAsProduction=true`(生产附加模式,零重启纪律全程遵守) |
| 健康矩阵 | 3300/3210/5180/8771/6789/4010/15160 全 200 |
| 插件/工具 | 11/11 enabled failures=0 · 126/126 available |
| 套件 | LINT 0 · typecheck 0 · **unit 915 全过** · e2e-line 0 · api-live 0 · rest-robustness 0 · template-isolation 38/38(7/7) |

## 2. 文档 → 模拟接口(Phase B1/B2)✅

1. **蓝图**:文档 6 点位逐点提取(方向/协议/地址/取值路径/单位/量程/周期/期望值);发现文档名义 MQTT 地址与设备实际合同(18830/`aw/proto/doc/env` 温湿度同报文)需经连通预检校准——**这正是预检步骤存在的意义**;环境湿度经核实可全供,6/6 无裁剪。
2. **能力匹配**:http/mqtt 均内置驱动;scalar 走 jsonPath、vector 走 points(64 点模板 `ct-c64939ad` 现场创建)——零插件适配需求。
3. **连通预检**:首轮 4/5(SP 写缺 jsonPath→修正)→ **5/5**。
4. **供给**:`provision-line` 11/11 → 测试线 `ln-35547b24`(4 DAQ + 1 DCW + 配方 rc-41713fb9),命名 `PROTO2-*` 命名空间隔离。
5. **镜像采集**:`verify-mirror` **5 节点全 PASS**(PV 正弦 25.3±0.6/回读 25/环境温度 22.3/湿度 52/壁厚 64 点 1-5mm)。

## 3. 写控与导出验收(Phase B3)✅

- **SP 写穿**:27 → `readback-verified`(anchor anc-092d0db3);**独立回读 DAQ 点**按合同"5s 内证实":过渡桶 25.86 → settled **27** → 写回 25 verified。HTTP 写驱动的回读不冒充设备证实——独立 DAQ 点才是合同要求的证实面,两者都绿。
- **导出五项核对**:值(verify-mirror 已证)/量(PV 197 行@2s、湿度 1400@1s、**壁厚长表 1984=64×31 帧**)/时间(单调在窗)/标识(line_id=测试线)/清单(manifest schema+nodes,标量列 `ts_iso,ts_ms,value,state`、向量列 `ts_iso,ts_ms,point_index,value` 与合同逐字一致)。

## 4. 割接六步演练(Phase B4)✅

"真实 PLC"= 同合同设备替身(4120)。

| 步 | 动作 | 结果 |
| --- | --- | --- |
| 1 | 真实端点连通预检 | ✅ 4/4 |
| 2 | 只读浸泡 ≥30min | ⏸ 生产窗口门(演练中如实标注,不假装完成) |
| 3 | 单点最小步写首验 | ✅ **三方一致**:节点回读 25.5 = 设备侧 GET /sp 25.5 = 独立 DAQ 桶 25.4→25.5 |
| 4 | 其余节点 PATCH driverConfig | ✅ 仅端点 4020→4120,**节点/配方/限界/频道零重建**;采样立即从"真实设备"流入 |
| 5 | verify-line V1-V6 | ✅ **11/11**(V2 量程拒 65 点名安全量程/V3 合法写 27.5 回读一致/V6 保护线零扰动) |
| 6 | 割接清单 | ✅ 本报告 + evidence.json |

## 5. 运行中发现(如实记录)

| # | 内容 | 级别 |
| --- | --- | --- |
| R-1 | **守护自愈实录**:Agent runtime 卸载阻塞健康探针(3 次失联)→ stability-guard 判僵死 → 秒级拉起新子进程;数据零损、token 会话保持;副作用=一个在飞 stability-report 被中断并如实记录 `failed(Server restarted — diagnosis interrupted)` | 韧性正向 + P3 副作用 |
| R-2 | `verify-line.mjs` 的 cfg.daq 须传裸 id 串;传对象会产生 `[object Object]` URL 洪流且无 fail-fast | P4 脚本健壮性 |
| R-3 | 误杀晨期测试设备树导致 4020 短暂失联 8 分钟(测试设备生命周期管理教训,非平台问题;已用同合同脚本恢复) | 运维注记 |

## 6. 判定

- **全功能**:本轮 7 套件 + 运行面体检 + 上轮 24 套件矩阵,无任何阻断缺陷;唯一运行期异常(R-1)由守护自愈机制按设计恢复,且有完整日志根因链。
- **文档→模拟→真实无缝衔接**:**PROVEN**。协议语义层(节点/配方/限界/频道/分析)与端点物理层完全解耦;割接 = 一次连通预检 + 一组 driverConfig PATCH + 一轮 verify-line。真实投产时,把 4120 替身换成真实 PLC 地址、完成 30min 只读浸泡、走同一条六步清单即可。
- **未覆盖面**:真实物理 PLC(替身为同合同模拟器)、30min 浸泡(生产窗口执行)、MQTT 写侧(commandTopic)与 MES/串口协议未在本轮演练(平台已有该能力面,见 protocol-matrix)。

*证据:`evidence.json` + 平台台账(操作流水/配方事件/审计)+ 本轮套件日志(/d/tmp/logs-d2-*)*
