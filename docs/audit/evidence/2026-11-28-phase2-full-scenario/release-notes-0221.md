# AgentWorkShop v0.22.1

桌面版本显示修复 + 记忆/检索模型验收轮加固 + 四协议接入验收验证。

## 修复

- **桌面版本显示**(本版主要修复):源码直启(`electron desktop/main.mjs`)时托盘/更新面显示的是 Electron 运行时版本(如 45.4.1)而非应用版本——`app.getVersion()` 在该模式下回退到运行时自身版本,旧护栏 `!== '0.0.0'` 拦不住。现在源码模式直接读取后端 package.json;打包版行为不变。

## 加固(验收轮实测通过)

- 本地检索模型(embedding)下载:流式进度、失败/取消回滚清理、已装模型拒重下(409)、取消端点按实际终态回报;
- 记忆团队检索:`buildMatchQuery` 统一 FTS 转义(修复跨频道团队检索报错)、向量榜按距离排名(`TEAM_VEC_K`)、触摸只计入选行;
- owner 共享区:`searchSharedExperience` 补 `memory_access_mode` 阀门(disabled/isolated/readonly);
- 记忆写入/更新:动态解析 embedding provider;vecInit 维度自愈;
- 接入脚本:`onboard.mjs` verify 配置透传 `ackMode`/`observeDaqId`(mqtt command-only 节点走 transport-ack + 独立 DAQ 观测判定);`verify-line.mjs` 支持 `protectedLineId` 基线夹具(缺省仍为受保护演示线)。

## 验收(2026-11-28)

四协议接入矩阵(HTTP / MQTT / Modbus-TCP / OPC-UA)全链:文档→孪生→供给→锻造→V1-V6→HITL 治理闭环(两次冒烟批次设备证实);同 Channel 差异化绑定权限矩阵(分析师只读/工艺专家读+recipe/零绑定 fail-closed);Runtime 元数据 CAS 热重载(下一回合行为改变);记忆中心 45s 即时整理 + 向量检索;桌面端实机(源码壳)派发任务 COMPLETED;受保护基线 V6 PASS(16/0)。证据:`docs/audit/evidence/2026-11-28-phase2-full-scenario/`。

## 安装

- npm:`npm i -g agentworkshop@0.22.1`(官方源)
- 桌面:本 Release 资产中的 Windows 安装包(静默安装 `/S`);应用内更新中心亦会提示。
