# Mimosa Security Scan

- Scan: `scan-2026-11-10T21-09-44.982Z-93427e219d0f`
- Created: 2026-11-10T21:09:44.982Z
- Depth: normal
- Run status: **completed**
- Findings: 14 (0 business-logic candidate)
- Verdict effect: `none`

## Findings

### HIGH · 硬编码凭据 (i18n/locales/en.ts:244)

static · static-finding

embedApiKey 的凭据值直接写在源码中，提交后可能造成密钥泄露。

### HIGH · 硬编码凭据 (i18n/locales/en.ts:289)

static · static-finding

mqttPassword 的凭据值直接写在源码中，提交后可能造成密钥泄露。

### HIGH · 硬编码凭据 (i18n/locales/zh-CN.ts:244)

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

### MEDIUM · 疑似跨文件污点 (scripts/acceptance-optimizer-process-model.ts:267)

cross-file · static-finding

环境变量 → projects/service.ts:4611 的 记录 ID 查询未绑定当前用户/租户

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/acceptance-optimizer-process-model.ts:631)

cross-file · static-finding

环境变量 → projects/service.ts:4611 的 记录 ID 查询未绑定当前用户/租户

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/acceptance-optimizer-process-model.ts:798)

cross-file · static-finding

环境变量 → projects/service.ts:4611 的 记录 ID 查询未绑定当前用户/租户

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/e2e-aml.ts:51)

cross-file · static-finding

环境变量 → mes/mes-controller.ts:764 的 SSRF 服务端请求伪造 server-side request

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (scripts/e2e-multi-harness.ts:100)

cross-file · static-finding

HTTP 请求输入 → manager/host-tools.ts:96 的 记录 ID 查询未绑定当前用户/租户

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (server/services/workshop/agents/industrial/bench-approval-only.ts:305)

cross-file · static-finding

环境变量 → 2026-10-31-experiment-consolidation/build_report.py:53 的 路径穿越 path-traversal（未校验路径）

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (server/services/workshop/db/channel-agent.repo.ts:145)

cross-file · static-finding

环境变量 → tests/ops-log-query.test.ts:51 的 SQL 执行

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### MEDIUM · 疑似跨文件污点 (server/services/workshop/dcw/drivers/mes-rest.ts:419)

cross-file · static-finding

HTTP 请求输入 → mes/mes-controller.ts:764 的 SSRF 服务端请求伪造 server-side request

Proof gaps:

- 静态 advisory 需要人工确认真实数据流和可利用性。

### HIGH · 路径穿越 (bench/tools/fig4_analyze.py:98)

static · static-finding

未校验的路径含 ../ 可访问预期之外的文件


---

This report is a projection of sealed JSON artifacts. It is not runtime verification.
