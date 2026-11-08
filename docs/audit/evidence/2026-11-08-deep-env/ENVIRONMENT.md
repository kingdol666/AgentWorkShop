# 深度测试环境档案（2026-11-08）

## 实例（挂起待命）
- **应用**: http://127.0.0.1:4001（控制台 /workshop）— PID 见 `netstat -ano | findstr :4001`
- **隔离 home**: `D:/codes/ABO/aw-mem-runtime/.deep-home-20261108`（`AW_MODE=home` + `AW_HOME` 强制隔离；数据/用户/产线布线全部独立）
- **代码**: main `144cce5f`（含并发会话 #90/#92），构建于本轮（build exit=0）
- **管理员**: deep-admin@aw.local / Deep#2026-test（首用户=owner，needsSetup 已消费）
- **服务日志**: server-4001.log（本目录）；DAQ Timescale 就绪（凭据继承自主 home），MQTT 队列就绪

## 产线现场（模拟器 :4010，PID 见 `netstat -ano | findstr :4010`）
- 4 条产线运行中（Modbus TCP / RTU / OPC UA / MQTT），4 DCW 节点 + 孪生，4 配方
- 数采 19/19 通道真实采样；test-driver 4/4 真连通
- 布线脚本: `AW_BASE=http://127.0.0.1:4001 node scripts/ui/seed-industrial-demo.mjs`（幂等，重布线会清理重建演示实体）

## 冒烟结果（全部通过）
- 健康/workshop ready；首用户注册；工作区/频道(群聊开)/会话/消息/mock 回复闭环
- 群聊 INVALID_TEXT 守卫实测：GBK 乱码被拒（UTF-8 正常投递）——shell 驱动 CJK 需走 node fetch
- 项目创建（draft）+ 产线频道绑定 + daq_query / line_context 实测 OK

## 旧实例清理记录
- 3001/3002/3580/3995/3996/3997：无监听（历史实例已退出）
- 3003（并发会话遗留 AW-sessions-ui 实例, PID 62644）: 已终止
- 僵尸进程 57684（持有 .deep-home 的首个启动尝试）: 已终止
- PLC 模拟器曾退出 → 已从 `D:/codes/ABO/AgentWorkShop/plc-node-simulator` 重启（:4010）

## 深度测试入口提示
- 产线治理写全链参考: `scripts/_audit/industrial-three-context-live.mjs` / `multi-channel-project-collab-live.mjs`（改 AW_BASE=4001 即可复跑，脚本自带重试/清理）
- 注意: 试验节拍 ≥300s/线；write_intent 节拍重试需重新申请；数据集构建需已完结批次
