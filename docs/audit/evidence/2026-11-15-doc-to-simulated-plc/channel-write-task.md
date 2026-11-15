# Channel 级闭环写控验收记录

- 时间：2026-11-15 23:4x
- Channel：`4a8b542b-d014-4aa5-bdea-bbeefc001ced`（production_line_integrated，绑线 `ln-0eb8f9fa`）
- Lead：`88165f86-5838-43ef-b430-fa138f5bb9e2`（omp）
- 任务：按频道工况上下文，将保压压力 SP 从约 50 MPa 提高到 52 MPa（+2 MPa，符合步限），走 recipe_propose + HITL，获批后回读。
- HITL：1 张 `dcw-approval`（`ap-0118a324`）获批（测试语义自动裁决）。
- 设备回读：**52 MPa**（`POST /api/workshop/dcw/dw-aed0ca16/read`）。
- 克重响应：约 **31.21 g → 31.37 g**（+2 MPa → +0.16 g，跟随率约 88%，滞后约 1min）。
- 飞边：0.17–0.19%（上限 0.4%，无恶化）。
- Lead 结论：方向有效但未达标（目标 32.50±0.35 g），按指令未继续调整；本次是 trial 下发，**未写配方版本**，换批/重启会回落 50MPa；若要固化需 `recipe_update`。
- 证据：Channel 消息、HITL pending/respond、DCW read、DAQ 克重/飞边样本。
