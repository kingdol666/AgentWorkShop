# idd-closedloop-bridge —— IDD 闭环分析桥

把 [industrial-deep-diagnostic](https://github.com/kingdol666) (IDD) 服务包装为 AgentWorkShop 的 OMP 工具 ×9:
哨兵(建档/秒筛/批筛/状态)、调优经验库(登记/检索/反馈)、目标闭环寻优(campaign/round/state)。

## 三步接线(首次部署必读)

1. **启动 IDD 后端**(默认 `http://127.0.0.1:3210`,健康检查 `GET /api/health`);
2. **签发 API Token**:IDD 服务开启了鉴权——`POST /api/auth/register`(注册,邮箱须含 TLD;首个用户自动 admin)→ `POST /api/auth/login` 取 session → `POST /api/auth/tokens` 签发 `idd_` 前缀 token(明文仅返回一次);
3. **填插件 settings**:平台设置页「IDD 服务连接」→ base_url + token,保存即热生效(或 `PATCH /api/system/settings {"override":{"plugins.idd-closedloop-bridge.token":"idd_..."}}`)。

## 数据交换目录(重要)

IDD 对数据路径有**沙箱**:只允许其仓库根内的路径,越界报 `path outside allowed roots`。
约定:**把要分析的 CSV 放入 `IDD仓库/workspace/aw-exchange/`**(或在本插件 settings 的「数据交换目录」登记该目录)。
平台侧 `daq_export(merge:true)` 产出的 merged.csv 复制/软链到此目录即可被 sentinel/experience 工具消费。

## 工具 ×9

| 工具 | 形态 | 用途 |
|---|---|---|
| sentinel_baseline | 异步 | 从历史稳态数据(+可选 doe-analyzer 产物)建产线基线 |
| sentinel_screen | 同步 ≤5s | 增量小窗(1-500 行)即时筛查 |
| sentinel_watch | 异步 ≤2min | 整窗批筛(SPC 规则/漂移投影/变点/多变量) |
| sentinel_status | 同步 | 查询异步任务;失败时透传 error 与日志尾 |
| experience_log | 异步归因 | 登记调参动作(经验库数据入口) |
| experience_recommend | 同步 | 按故障签名检索 playbook(E0-E3 分级+降级链) |
| experience_feedback | 同步 | 回填动作结果(effective/ineffective/harmful) |
| optimizer_campaign / optimizer_round / optimizer_state | 异步/同步 | 目标闭环寻优 |

分析结论入库知识库:调用 rag-bridge 的 `kb_agent`,标题带工况场景(regime_key)。
