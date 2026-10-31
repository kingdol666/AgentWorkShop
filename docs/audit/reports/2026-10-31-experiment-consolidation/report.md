# 2026-10-31 实验结果汇总与论文证据审查

## 结论

最新 integrated 批次 `20261031034253-1dbo`：76 PASS、1 WARN、0 FAIL（加权评分 99.6/100）。本地确定性模拟环境覆盖五种协议，5 个采集节点记录 54 个样本，四种可写协议的负向探针 24/24 拒绝，写操作 p50=31.649 ms。该批运行未启用 LLM Agent harness。

闭环仿真 `J/J*`：42: 98.8% (writes=2, iterations=2); 43: 96.3% (writes=0, iterations=0); 44: 98.3% (writes=2, iterations=2)；均值 97.8%。seed 43 为 0 写入/0 迭代。BOPET 单次任务写入 3 个参数后报告膜厚 24.84 µm，落在 25±0.7 µm 内，但日志/汇总的优化账本存在未闭合差异。

## 批次和流程状态

<table><thead><tr><th>Run</th><th>阶段检查</th><th>J/J*均值</th><th>checker hash</th><th>备注</th></tr></thead><tbody><tr><td>20261031030602-1sng</td><td>73 pass / 4 warn / 0 fail</td><td>97.5%</td><td>f1b50e757e309bc6</td><td>same seed/shared state; not pooled as n=3</td></tr><tr><td>20261031032514-1eyw</td><td>75 pass / 2 warn / 0 fail</td><td>97.7%</td><td>1ce2f2bcc2ded098</td><td>same seed/shared state; not pooled as n=3</td></tr><tr><td>20261031034253-1dbo</td><td>76 pass / 1 warn / 0 fail</td><td>97.8%</td><td>82daeac2691efc94</td><td>same seed/shared state; not pooled as n=3</td></tr></tbody></table>

- 首轮 `20261031025846-czk` 因私有模拟器预启动隔离检查超时而未进入有效阶段，0 线/0 样本，排除在实验分母外并保留审计记录。
- 多场景 `20261031033645-22n0` 判 FAIL：注塑/污水/退火 3 项达标；BOPET 0 次写入、0 次迭代，27.40 µm 未达 25±0.7 µm。
- 同 seed、共享 AW_HOME，checker hash 变化，不将上述 PASS 重跑视为统计独立重复。

## 消融结果

<table><thead><tr><th>Arm</th><th>负向拦截</th><th>窗口越限到达驱动</th><th>合法请求误拦</th></tr></thead><tbody><tr><td>full</td><td>18/18 (100.0%)</td><td>0</td><td>0/69</td></tr><tr><td>no-interlock</td><td>12/18 (66.7%)</td><td>6 total (2/repeat)</td><td>0/69</td></tr><tr><td>no-readback</td><td>18/18 (100.0%)</td><td>0</td><td>0/69</td></tr><tr><td>ungated</td><td>12/18 (66.7%)</td><td>6 total (2/repeat)</td><td>0/69</td></tr></tbody></table>

E1a 是 API/mock 层四臂消融，每臂 3 repeats、每次 6 个负向探针；full/no-readback 为 18/18 拒绝，no-interlock/ungated 为 12/18 拒绝，窗口类请求每 repeat 有 2 个到达 mock driver（每个受影响臂共 6 个）。A1 审批门 ON/OFF 与 A2 Harness×模型矩阵均 NOT-RUN、runner NOT-IMPLEMENTED。

上下文比较组件消融：启用时 12/12 个身份字段挑战在写入前拒绝；移除测试变体中的 tuple comparison 后，product/run 6 个挑战到达 mock driver，各产生 2 次 mock writes 和 1 条 execution record；line/recipe 六个仍被其他检查拒绝。不是审批门消融。

## 文档驱动虚拟线验收

独立批次：provision 11/11；新线 DAQ 5/5 在线；lead 只读任务完成，检查 5 条 acquisition streams（含 64 点向量）；导出 19/19（标量 818 行，向量 54×64=3,456 点）。独立管理员 SP=25→27→25，独立 DAQ 两次读回一致；写入未关联 Agent task/actor/approval/driver event。

## 真实 harness 与论文边界

P12 OMP/Qwen 配置 episode 资格通过，但 workflow 与 evidence integrity FAIL，task CANCELED，0 verified approvals、0 accepted governed writes。不得作为成功 Agent evidence。软件回归：unit 913/915 pass（2 skipped），MCP 14/14、plugin lifecycle 22/22、twin-provider 5/5、skills 147/147、line-governance 44/44；这些是契约/回归证据，不是工艺结果。

当前结果可支持模拟器中的系统集成可行性和限定的软件治理行为；不能支持审批因果效应、Harness/模型可替换性、多 Agent 自主优化或物理设备表现。

## 复现与审计

- 主命令：`node bench/pipeline.mjs --profile integrated --seed 42 --cl-seeds 3`
- E1a：见 `bench/results/20261030171011-e1lite/report.md` 与 `e1-lite.csv`。
- 图表、数据 CSV、生成脚本和事后 SHA-256 清单与本报告同目录。
- 当前 integrated raw bundle 缺少运行时 SHA256SUMS；本报告的 hash 是生成时核验的事后指纹，不是原始冻结证明。
