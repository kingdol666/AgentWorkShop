# E3 单机制审批消融 · 本轮执行记录(2026-11-03)

> 结论:**NOT-RUN(环境阻断)**。未产出可写论文的 OFF 臂证据;不降级、不伪造。

## 1. 准备(已完成)

- 模板 AW_HOME:由 2026-11-01 批次 home 克隆 → `D:/tmp/aw-a1-template`;
- 目标:line `ln-3856f218`(注塑场景)/ recipe `rc-a17659b1` / node `dw-b32cd27a`(hold-pressure-sp,OPC UA)/ actor `3436b21d-...`;
- 修正模板 fixture:`controlMode=manual`、`simulated=true`、`simSceneId=injection`;
- 预注册:15 对 block(legal-approved / legal-rejected / out-of-range-approved × 5),seed 42,`--network none`。

## 2. 执行与失败

```bash
node bench/PIPELINE/run-approval-ablation-pilot.mjs prepare --run-id a1-20261103-e3 \
  --template-home D:/tmp/aw-a1-template --actor-id 3436b21d-15f8-438d-a957-0bb2d9f33750 \
  --line-id ln-3856f218 --recipe-id rc-a17659b1 --node-id dw-b32cd27a \
  --sim-device-id inj-inject-opcua --sim-signal-id hold-pressure-sp \
  --legal-value 50 --control-value 60 --sim-base http://127.0.0.1:4012 --aw-port 3392 --seed 42
```

| 尝试 | 结果 |
|---|---|
| 1 | `target line must already use manual control mode`(fixture 修正后重试) |
| 2 | 基础镜像拉取失败:`dial tcp 157.240.8.41:443 ... failed to respond`(Docker Hub 不可达) |
| 3 | 国内镜像 `docker.m.daocloud.io/library/node:23-bookworm-slim` 拉取成功并本地 tag;构建期代理(`host.docker.internal:7890`)验证可访问 npm registry |
| 4 | 镜像构建(`pnpm install` + `pnpm build` + 模拟器 npm ci)期间 Docker Desktop 引擎返回 **500 Internal Server Error / CLI 无响应** |

## 3. 环境恢复

- 终止构建进程;
- `docker desktop restart`;
- `awshop-daq-timescale` / `awshop-daq-minio` / `awshop-daq-mosquitto` 自动恢复;
- `pps-minio` / `pps-postgres` 手动 `docker start` 恢复;当前全部 Up。

## 4. 复跑条件

需要 Linux 主机或资源充足、可访问镜像仓库的 Docker 环境(构建阶段约需 3 GB 内存与 10–15 min)。
准备通过后:

```bash
node bench/PIPELINE/run-approval-ablation-pilot.mjs preflight --run-id <RID>
node bench/PIPELINE/run-approval-ablation-pilot.mjs pilot --run-id <RID> --confirm <RID>
node bench/PIPELINE/run-approval-ablation-pilot.mjs finalize --run-id <RID>
```

未运行前:论文不得出现“审批门单机制拦截率”或“审批×模式交互效应”。
