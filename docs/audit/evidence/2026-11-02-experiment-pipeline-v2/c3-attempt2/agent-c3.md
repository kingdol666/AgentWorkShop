# E2-C3 活体 Agent 多轮闭环(标准化运行)

- runId: `20261102104327-agent-multiround`
- scenarios: injection · episodes: 1 · budget: 15 min/episode
- 判据:PV/守卫取平台独立数据面(optloop summary),写次数/轮次由 recorder 产物推导(不从 Agent 自述取数)

| scene | run | finalState | PV | 目标带 | inBand | guards | writes | rounds | wall(s) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |

> 口径:每次 episode 均为 fresh 复位;C3 无 seed,run 序号是独立重复;
> 不与 C1 按 seed 配对(C1 是确定性脚本策略,C3 是 LLM 驱动,回合时延不可控)。