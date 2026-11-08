# Mimosa Security Scan

- Scan: `scan-2026-11-08T21-27-29.432Z-b02ab844fc7c`
- Created: 2026-11-08T21:27:29.432Z
- Depth: deep
- Run status: **inconclusive**
- Findings: 33 (0 business-logic candidate)
- 覆盖缺口:
  - 部分分析阶段未能完整覆盖
- Verdict effect: `none`

## Findings

### HIGH · 硬编码凭据 (i18n/locales/en.ts:243)

static · static-finding

embedApiKey 的凭据值直接写在源码中，提交后可能造成密钥泄露。

### HIGH · 硬编码凭据 (i18n/locales/en.ts:288)

static · static-finding

mqttPassword 的凭据值直接写在源码中，提交后可能造成密钥泄露。

### HIGH · 硬编码凭据 (i18n/locales/zh-CN.ts:243)

static · static-finding

embedApiKey 的凭据值直接写在源码中，提交后可能造成密钥泄露。

### HIGH · 硬编码凭据 (scripts/test-group-chat-unit/lib.ts:138)

static · static-finding

password 的凭据值直接写在源码中，提交后可能造成密钥泄露。

### MEDIUM · 疑似跨文件污点 (paper/tii/revision-2026-10-26/s1-staging/revision-2026-10-25/source-snapshot/server/services/workshop/dcw/dcw-controller/write.ts:164)

cross-file · static-finding

环境变量 → drivers/http.ts:40 的 SSRF 服务端请求伪造 server-side request

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · writeSamples 是 sql-injection 入口 (scripts/acceptance-optimizer-process-model.ts:264)

cross-file · static-finding

不可信数据「环境变量」流入 writeSamples() → 污点链：writeSamples(sink:sql-injection) （定义于 storage/timescale.adapter.ts）

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/acceptance-optimizer-process-model.ts:267)

cross-file · static-finding

环境变量 → projects/service.ts:4357 的 记录 ID 查询未绑定当前用户/租户

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/acceptance-optimizer-process-model.ts:631)

cross-file · static-finding

环境变量 → projects/service.ts:4357 的 记录 ID 查询未绑定当前用户/租户

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/acceptance-optimizer-process-model.ts:798)

cross-file · static-finding

环境变量 → projects/service.ts:4357 的 记录 ID 查询未绑定当前用户/租户

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/e2e-aml.ts:51)

cross-file · static-finding

环境变量 → mes/mes-controller.ts:764 的 SSRF 服务端请求伪造 server-side request

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · fetch 是 ssrf 入口 (scripts/e2e-aml.ts:51)

cross-file · static-finding

不可信数据「环境变量」流入 fetch() → 污点链：fetch(sink:ssrf) （定义于 mes/mes-controller.ts）

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:151)

cross-file · static-finding

不可信数据「环境变量」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:157)

cross-file · static-finding

不可信数据「环境变量」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:175)

cross-file · static-finding

不可信数据「环境变量」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:199)

cross-file · static-finding

不可信数据「命令行参数」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:206)

cross-file · static-finding

不可信数据「命令行参数」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:212)

cross-file · static-finding

不可信数据「环境变量」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:218)

cross-file · static-finding

不可信数据「环境变量」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:222)

cross-file · static-finding

不可信数据「环境变量」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:227)

cross-file · static-finding

不可信数据「环境变量」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:242)

cross-file · static-finding

不可信数据「环境变量」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · api 是 ssrf 入口 (scripts/e2e-aml.ts:246)

cross-file · static-finding

不可信数据「环境变量」流入 api() → 污点链：api(sink:ssrf)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/e2e-multi-harness.ts:100)

cross-file · static-finding

HTTP 请求输入 → manager/host-tools.ts:96 的 记录 ID 查询未绑定当前用户/租户

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · invokeHostTool 是 idor 入口 (scripts/e2e-multi-harness.ts:100)

cross-file · static-finding

不可信数据「HTTP 请求输入」流入 invokeHostTool() → 污点链：invokeHostTool(sink:idor) （定义于 manager/host-tools.ts）

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · dispatch 经 1 跳到达 path-traversal (server/api/workshop/a2a/[agentId]/rpc/index.post.ts:431)

cross-file · static-finding

不可信数据「HTTP 请求输入」流入 dispatch() → 污点链：dispatch → parseParams(sink:path-traversal)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (server/services/workshop/agents/industrial/bench-approval-only.ts:305)

cross-file · static-finding

环境变量 → 2026-10-31-experiment-consolidation/build_report.py:53 的 路径穿越 path-traversal（未校验路径）

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · stableJson 是 mongo-sort-injection 入口 (server/services/workshop/agents/industrial/bench-approval-only.ts:308)

cross-file · static-finding

不可信数据「环境变量」流入 stableJson() → 污点链：stableJson(sink:mongo-sort-injection)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · stableJson 是 mongo-sort-injection 入口 (server/services/workshop/agents/industrial/bench-approval-only.ts:318)

cross-file · static-finding

不可信数据「环境变量」流入 stableJson() → 污点链：stableJson(sink:mongo-sort-injection)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (server/services/workshop/db/channel-agent.repo.ts:145)

cross-file · static-finding

环境变量 → tests/ops-log-query.test.ts:51 的 SQL 执行

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · run 是 sql-injection 入口 (server/services/workshop/db/channel-agent.repo.ts:145)

cross-file · static-finding

不可信数据「环境变量」流入 run() → 污点链：run(sink:sql-injection) （定义于 tests/ops-log-query.test.ts）

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (server/services/workshop/dcw/drivers/mes-rest.ts:419)

cross-file · static-finding

HTTP 请求输入 → mes/mes-controller.ts:764 的 SSRF 服务端请求伪造 server-side request

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · fetch 是 ssrf 入口 (server/services/workshop/dcw/drivers/mes-rest.ts:419)

cross-file · static-finding

不可信数据「HTTP 请求输入」流入 fetch() → 污点链：fetch(sink:ssrf) （定义于 mes/mes-controller.ts）

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · 路径穿越 (bench/tools/fig4_analyze.py:98)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件


---

This report is a projection of sealed JSON artifacts. It is not runtime verification.
