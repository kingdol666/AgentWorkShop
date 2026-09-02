# 第一次「Agent × 产线」会话(约 2 分钟)

1. **登录** —— 打开 `http://localhost:3001`,侧边栏注册/登录
   (种子管理员:`zhangwei@awshop.io` / `Awshop@123`,首登请改密)。
2. **搭产线** —— 「产线运营」→ 新建产线 → 添加**数控节点**(如模板 `temp-sp`)
   与**数采节点**(如模板 `temp-tc`)→ 新建**产品**(挂到产线)→ 新建**配方**
   (参数绑定数控节点,如目标 120)→ 点**开跑**。
   实时值开始流动,每条样本自动打标 `line/product/recipe/run`。
3. **建团队** —— 「Agent 工作台」→ 创建 Agent → 创建 Team → 把 Agent 加入编组。
4. **绑定节点** —— 打开 Agent 详情面板 → 绑定数采节点(*auto* = 自动执行)
   与数控节点(*manual* = 每次写入需要你的批准)。
5. **提交目标** —— 「分析最近 5 分钟温度;若与 182℃ 偏差超过 1℃,修正设定值(等我的批准)。」
6. **审批** —— Agent 读取真实历史、计算均值、发起写请求 → 在 HITL 面板批准 →
   设定值变化、回读校验通过、goal 收口并给出数值报告。

## 全程发生了什么

```
目标 ──▶ lead 分解 ──▶ worker 读取 TSDB 真实历史(语义卡片:含义/单位/量程/配方窗口)
     ──▶ 计算建议设定值 ──▶ dcw_control 工具 ──▶ 联锁(安全量程 ∩ 配方窗口)
     ──▶ HITL 人工批准(180s 超时默认拒绝) ──▶ PLC 写入 ──▶ 回读校验
     ──▶ ACK + 签名写历史 ──▶ goal 满足判定通过
```

## 用 CLI 验证

```bash
aw config get server.prod.port          # 端口来源
aw status                               # 运行态总览
curl -X POST http://localhost:3001/api/plugins/line-sentinel/threshold \
  -H 'content-type: application/json' -d '{"threshold":100}'   # 插件 API(如已安装示例)
```
