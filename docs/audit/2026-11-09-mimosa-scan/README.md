# Mimosa 全仓安全扫描记录（2026-11-09）

> 运行对象：`D:\codes\ABO\aw-mem-runtime`（v0.10.0 文档/发布候选）
> 工具：Mimosa MCP `security_scan_start`（depth=deep）
> 结论：**inconclusive —— 不是“安全通过”证明**。保留完整产物以便复验。

## 1. 扫描元数据

| 项 | 值 |
|---|---|
| Scan ID | `scan-2026-11-08T21-27-29.432Z-b02ab844fc7c` |
| Job ID | `scan-job-mw8cf3wi-5421727fce496bfa` |
| Seal | `sha256:fed56fb187aedd5f1d24220c5dd8031fcca493ad109f85904f48a76c0943fda0` |
| 运行状态 | `inconclusive` |
| 完整度 | `partial`（threatModel partial · findingDiscovery partial · validation 0 investigated · traces 0） |
| 发现数 | 33（0 business-logic candidate） |
| 依赖面 | 62 packages scanned · 0 matched advisories · 0 unknown |
| 证据边界 | `static_only_no_runtime_execution`（静态分析，不是运行时验证） |
| Verdict effect | `none` |

产物：[`report.md`](report.md) · [`coverage.json`](coverage.json) · [`findings.json`](findings.json) · [`seal.json`](seal.json)。

## 2. 33 条发现的定性（人工复核）

扫描器把以下模式标为 HIGH/MEDIUM；逐条查看后，没有发现本次改动引入的新漏洞：

| 类别 | 位置（示例） | 定性 |
|---|---|---|
| 硬编码凭据 | `i18n/locales/{en,zh-CN}.ts` 的 `embedApiKey` / `mqttPassword` | **误报**：这些是设置页的字段标签文案（“Embedding 密钥”），不是密钥值 |
| 测试口令 | `scripts/test-group-chat-unit/lib.ts` | 单测固定口令 `Passw0rd!123`，仅测试库使用 |
| SSRF 静态链 | `scripts/e2e-aml.ts` → `api()` / `fetch()`、`mes-rest.ts` → MES 控制器 | 验收脚本的目标地址来自环境变量；MES 驱动地址来自管理员配置，属于集成面设计，不是匿名输入 |
| SQL 注入静态链 | `scripts/acceptance-optimizer-process-model.ts` → `writeSamples()`、`channel-agent.repo.ts` → `rotateToken` | 前者是验收脚本；后者使用预编译语句，环境变量仅参与宽限窗计算 |
| 跨文件污点/IDOR | `projects/service.ts` 决策审计、`host-tools.ts` | 静态链未证明可达；需要结合调用方授权做人工审计 |
| 路径穿越 | `bench/tools/fig4_analyze.py:98` | CLI 工具接收 `--json` 输出路径，属于本地工具参数；不作为服务端输入 |
| A2A 路径穿越链 | `a2a/[agentId]/rpc/index.post.ts` → `dispatch → parseParams` | 需要结合具体 RPC 方法校验；静态链未证明可利用 |

## 3. 结论与建议

- **不能宣称“安全全通过”**：本次扫描的威胁建模与发现阶段均为 partial，validation 未执行任何调查；
- **没有新增高危证据**：33 条里没有一条指向本次 README/VitePress/版本号改动；
- **建议后续**：
  1. 对 MES/HTTP 集成面增加目标 allowlist（SSRF 纵深防御）；
  2. 对 `ProjectService` 的按 ID 查询做一次调用方/租户绑定复核；
  3. 对 A2A `dispatch` 的参数解析补一个路径/命令注入的负面用例；
  4. 在 CI 中固定 Mimosa 版本与完整度检查，避免 partial 被误读为 pass。

> 本记录只描述“扫描器看到了什么”，不构成安全认证。发布说明与 README 不应引用本文件作为“安全通过”的依据。
