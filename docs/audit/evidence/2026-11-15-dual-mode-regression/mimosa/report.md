# Mimosa Security Scan

- Scan: `scan-2026-11-15T04-19-13.703Z-d5fddcefc407`
- Created: 2026-11-15T04:19:13.703Z
- Depth: deep
- Run status: **inconclusive**
- Findings: 47 (0 business-logic candidate)
- 覆盖缺口:
  - 部分分析阶段未能完整覆盖
- Verdict effect: `none`

## Findings

### HIGH · 代码注入 (data/workspaces/e323cfa9-a7b9-4880-9097-dccecb9ba673/train_linear.py:156)

static · static-finding

外部数据进入 eval 被当代码执行，可执行任意 Python

### HIGH · 命令注入 (server/services/workshop/evidence/candidate-store.ts:77)

static · static-finding

用户输入被拼进系统命令执行，攻击者可执行任意命令

### HIGH · 硬编码凭据 (i18n/locales/en.ts:263)

static · static-finding

embedApiKey 的凭据值直接写在源码中，提交后可能造成密钥泄露。

### HIGH · 硬编码凭据 (i18n/locales/en.ts:308)

static · static-finding

mqttPassword 的凭据值直接写在源码中，提交后可能造成密钥泄露。

### HIGH · 硬编码凭据 (i18n/locales/zh-CN.ts:263)

static · static-finding

embedApiKey 的凭据值直接写在源码中，提交后可能造成密钥泄露。

### HIGH · 硬编码凭据 (scripts/test-group-chat-unit/lib.ts:138)

static · static-finding

password 的凭据值直接写在源码中，提交后可能造成密钥泄露。

### LOW · 不安全的随机数 (paper/tii/revision-2026-10-20-tenpage/review-final/_compile-check-current/figures/make-architecture.py:43)

static · static-finding

随机性不足。

### HIGH · main 是 path-traversal 入口 (data/workspaces/10f00aca-063a-4f86-b0b2-c4bec3874c2d/verify_p2_dataset.py:159)

cross-file · static-finding

不可信数据「命令行参数」流入 main() → 污点链：main(sink:path-traversal)

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

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

环境变量 → projects/service.ts:4986 的 记录 ID 查询未绑定当前用户/租户

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/acceptance-optimizer-process-model.ts:631)

cross-file · static-finding

环境变量 → projects/service.ts:4986 的 记录 ID 查询未绑定当前用户/租户

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/acceptance-optimizer-process-model.ts:798)

cross-file · static-finding

环境变量 → projects/service.ts:4986 的 记录 ID 查询未绑定当前用户/租户

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

### HIGH · 路径穿越 (bench/tools/fig4_analyze.py:98)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/10f00aca-063a-4f86-b0b2-c4bec3874c2d/export_aml_dataset.py:234)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/10f00aca-063a-4f86-b0b2-c4bec3874c2d/export_aml_dataset.py:259)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/10f00aca-063a-4f86-b0b2-c4bec3874c2d/export_aml_dataset.py:462)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/10f00aca-063a-4f86-b0b2-c4bec3874c2d/export_p2_dataset.py:259)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/10f00aca-063a-4f86-b0b2-c4bec3874c2d/export_p2_dataset.py:268)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/10f00aca-063a-4f86-b0b2-c4bec3874c2d/export_p2_dataset.py:457)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/55f2689c-c7bc-4bc1-a582-1a523fa4bc5f/ln-eb98f281_temp_analyze.py:327)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/cb76e2a2-1f33-4ac8-9429-07a4d2d511f4/aml_ds2_report.py:170)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/e323cfa9-a7b9-4880-9097-dccecb9ba673/_smoke4/amlkit.py:41)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/e323cfa9-a7b9-4880-9097-dccecb9ba673/_smoke4/amlkit.py:53)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/ef62d27d-7e33-4187-813f-eaf288edf918/src/state/capture.py:191)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/f4b94c26-5054-4495-b7e0-ac66d6af5dc0/aml_stage1_analysis.py:258)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (data/workspaces/f4b94c26-5054-4495-b7e0-ac66d6af5dc0/aml_stage1_final.py:254)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (paper/tii/revision-2026-10-20-tenpage/review-final/_compile-check-current/figures/make-architecture.py:111)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件

### HIGH · 路径穿越 (paper/tii/revision-2026-10-20-tenpage/review-final/_compile-check-current/figures/make-manifest.py:101)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件


---

This report is a projection of sealed JSON artifacts. It is not runtime verification.
