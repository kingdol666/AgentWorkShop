# 五协议数采与数控

AgentWorkShop 的数采(DAQ)与写控(DCW)驱动面覆盖五种现场协议,采集与下发同一套驱动注册表,
连接池、故障分类诊断、逐驱动连接测试开箱即用。`mock` 驱动用于演示与 CI;插件可注册自定义协议。

## 协议矩阵

| 协议 | 数采 | 数控 | 关键配置 |
|---|---|---|---|
| Modbus TCP | ✅ 保持/输入寄存器,int16~float32,big/little/wordSwap | ✅ 写保持寄存器 + 回读校验 | `host` `port` `unitId` `register`(40001 风格) |
| Modbus RTU(串口网关透传)| ✅ 同上(connectTcpRTUBuffered)| ✅ FC10 写 + FC03 回读 | 同 TCP,端口指向网关 |
| OPC UA | ✅ 会话池,任意 NodeId,匿名/Sign | ✅ 写 Double 节点 + 回读 | `endpoint` `nodeId` |
| MQTT | ✅ 订阅主题 + jsonPath 取值 | ✅ 发布 `{jsonKey: 值}` | `host` `port` `topic` `jsonPath` |
| HTTP | ✅ GET + jsonPath | ✅ POST `{bodyKey: 值}` + 响应回读 | `url` `jsonPath` / `bodyKey` |

## 连通性测试

创建节点前先测驱动(前端向导内置「测试连接」步骤):

```bash
# 按参数直测(不经节点)
curl -X POST $API/api/workshop/daq/test-driver \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"driver":"modbus-tcp","driverConfig":{"host":"127.0.0.1","port":1502,"unitId":1,"register":40001,"registerType":"holding","dataType":"float32"}}'

# 已建节点自测
curl -X POST $API/api/workshop/daq/$NODE_ID/test -H "Authorization: Bearer $TOKEN"
```

## 采样模型

- **每节点独立边缘运行时**:采集节拍(`intervalMs`)与 WS 下发节拍(`publishIntervalMs`)分离,
  单节点慢/停不波及邻居。
- **产线门控**:节点挂到产线(lineId)且产线开跑(绑定产品/配方批次)后才开始采集;
  停线即 offline。未分配节点不采集。
- **批次打标**:运行中的每个样本自动携带 `product/recipe/runId`,数据按批次隔离查询。

## 写控安全链

所有下发(手动 REST / 配方批次 / Agent 工具)共用单一入口,顺序经过:

1. 网关/节点启停门控(停用节点一律拒绝);
2. 产线写控权限(operate 权限);
3. Agent 互斥与回退冷却(调控闭环护栏);
4. 安全量程 ∩ 活动配方工艺窗口联锁;
5. (manual 绑定模式)HITL 人工审批;
6. PLC 写入 → 回读校验(超容差判失败)→ 签名写历史。

配方参数引用的节点若已删除/停用/解绑,下发时自动跳过并在批次结果中记明原因,
界面与 Agent 侧同步显示「已停用 / 已取消绑定 / 已删除」。
