# 固定时窗配对协调器：软件验证版

**状态：仅软件测试。真实 AgentWorkShop / PLC 模拟器适配器尚未实现。**
该目录中的唯一适配器是纯内存、虚拟时钟的合成夹具，不使用网络、不调用平台、不产生可写入论文的实验数据。
命令行明确拒绝其他适配器；输出中的 `paperEligibility` 固定为 `NOT_QUALIFIED`。不能把此处的运行记录转换、包装或转述成真实实验。

此协调器用于验证未来执行层的基本协议：在看结果前固定场景、seed、共同 horizon、采样间隔、动作、平衡臂序；每臂重置；逐采样记录时间偏移；将拒绝、异常、超时和重置不匹配保留；禁止覆盖已有目录；C0 若出现写入记录则标记失败。它不以 C0/C1 是否达标或观察到何种方向决定有效性。`plan.sha256` 发现计划变更，但不能证明冻结时间或抵抗同时篡改计划和哈希，正式实验还需独立预注册/不可变存储。

在仓库根目录运行下列**软件自检**（以下路径应是尚不存在的临时目录；Windows 可替换为自己的临时目录）：

```powershell
node --test bench/paper-runner/paired.test.mjs
node bench/paper-runner/paired.mjs freeze --out "$env:TEMP\aw-fixture-plan-example" --scenes injection,anneal --seeds 42,43 --horizon-ms 1000 --sample-ms 100 --order-seed 7
node bench/paper-runner/paired.mjs run --plan "$env:TEMP\aw-fixture-plan-example" --out "$env:TEMP\aw-fixture-run-example" --adapter synthetic-fixture
```

重复运行应使用全新目录；命令不会覆盖旧计划或输出。`journal.jsonl` 在每一步追加 episode 开始、reset、采样、写入尝试/返回及结束，因此进程意外中断后没有最终 manifest 时仍能识别未收口步骤。`episodes.jsonl` 是已结束 episode 的完整记录；`manifest.json` 汇总执行状态与文件摘要。所有产物均为 fixture。

## 正式适配器还需要什么

后续真实隔离适配器至少须完成以下工作并通过独立核验后才能考虑纳入论文实验：

1. 独立确认平台和模拟器进程、配置根、驱动、网络隔离及设备身份；不得自动接入或重置共享实例。
2. 记录完整的平台/模拟器源码与构建版本、dirty 状态、场景和环境指纹；逐 episode 将初始 setpoint、扰动与随机状态复位，并从独立来源核对初态与采样水位。
3. 以预先定义的真实单调时间和统一固定 horizon 收集带原始时间戳的 DAQ 全轨迹；验证样本新鲜度、单位、缺失率和窗口覆盖，不能把最近一次陈旧读数当成 reset 后的观测。
4. C1 通过真实受治理调用执行固定策略，C0 无写；从独立服务端来源对账全部写请求、驱动到达、回执、可选设备回读和观测，保留拒绝、超时和不完整记录。
5. 支持受控停止、失败收口和复位；提前冻结真实计划、数据质量规则、排除规则和报告方式。故障或未能确认来源时为 `NOT_QUALIFIED`，不可补造事件或选择成功运行。

正式研究的预注册、证据包和资格核验见 `bench/paper-study/` 与论文目录的实验设计文档；当前两个工具不自动互转数据，也未提供真实后端。

## E7 Harness/模型组合登记（离线脚手架）

`bench/experiment/paper-agent-comparison.mjs` 在采集前冻结每个 scene × seed 下的全部 OMP/OpenCode × 模型组合，并按登记的 `order_seed` 生成可重现的组内随机顺序。任务、配置、隐藏判定依据、提示、权限及构建均以 SHA-256 指纹标记；模型和 Harness 版本、工具调用预算、共同 horizon 和 1 秒 DAQ 桶采样间隔均在计划中固定。哈希只能发现变更，不能证明计划已在结果出现前独立注册。

计划文件字段如下；下列零值指纹和版本仅用于说明格式，必须在真实实验准备阶段以实际冻结文件及版本替换，且不能作为实验数据：

```json
{
  "schema": "paper-agent-comparison-plan/v1",
  "scenes": [{"id": "injection", "task_sha256": "0000000000000000000000000000000000000000000000000000000000000000", "configuration_sha256": "0000000000000000000000000000000000000000000000000000000000000000", "oracle_sha256": "0000000000000000000000000000000000000000000000000000000000000000"}],
  "seeds": [42, 43],
  "harnesses": [{"id": "omp", "revision": "replace-version"}, {"id": "opencode", "revision": "replace-version"}],
  "models": [{"provider": "local", "id": "example-model", "revision": "replace-version"}],
  "prompt_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "permissions_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "runner_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "platform_build_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "simulator_build_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "budget_ms": 120000, "max_tool_calls": 20, "horizon_ms": 60000, "sample_interval_ms": 1000, "order_seed": "precommitted-order"
}
```

```powershell
$e7Plan = 'D:\tmp\paper-agent-plan.json'
$e7Registration = 'D:\tmp\aw-e7-registration-01'
$e7Inventory = 'D:\tmp\aw-e7-inventory-01'
node bench/experiment/paper-agent-comparison.mjs freeze --plan $e7Plan --out $e7Registration
node bench/experiment/paper-agent-comparison.mjs inventory --registration $e7Registration --out $e7Inventory
node --test bench/experiment/paper-agent-comparison.test.mjs
```

登记目录为每次 episode 保留固定 ID；`inventory` 会检查 `episodes/<episode_id>/episode.json` 中是否保留登记的身份、指纹和预算，并检查该目录下的 `task.jsonl`、`harness.jsonl`、`model.jsonl`、`tool.jsonl`、`approval.jsonl`、`driver.jsonl`、`readback.jsonl` 和 `daq.jsonl`。不存在的 episode 标为 `NOT_RUN`；失败、超时、取消、零写、配置错配及缺失或损坏 trace 逐条保留。报告以全部计划 episode 为分母，列出声明状态的互斥计数；缺失计入 `NOT_RUN`，记录或配置无效计入 `INVALID`。`COMPLETED` 仅是未核验的声明，并非任务成功，任何记录仍为 `NOT_QUALIFIED`。清点报告写入后命令返回非零状态，防止调用方把清点完成误认为实验合格。JSONL 的存在与格式不能证明事件真实、独立或完整，空的 approval/driver/readback 文件也不能证明没有对应事件。

**实际 E7 采集仍为 `NOT_IMPLEMENTED / NOT_RUN`。** `acquire` 命令立即拒绝，不启动服务、不调用模型。真实执行器仍须认证运行中的隔离平台/模拟器进程、启动配置与 build、启动时的 audit sink/run ID，并闭合任务、模型、工具、驱动、回读及 DAQ 的系统侧关联；这些工作未被离线登记替代。
