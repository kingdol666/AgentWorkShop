# AML Hybrid Twin Plugin SDK 与多场景热加载实施计划

- 状态：已实施核心 Phase 0–6；FEM/CFD/DEM sidecar 保留为后续阶段。
- 日期：2026-09-25
- 范围：Provider/ScenePack/solver contract、Registry、SDK bridge、Channel provider lineage、默认注塑 provider、外部 thermal demo provider、热加载/回滚。

## 已实施

### Provider Registry

- `server/services/workshop/aml/twin/provider-contracts.ts`
- `server/services/workshop/aml/twin/provider-registry.ts`
- `server/services/workshop/aml/twin/provider-health.ts`
- `server/services/workshop/aml/twin/provider-loader.ts`

支持：

- Provider/ScenePack/SolverAdapter 统一契约；
- provider hash；
- generation；
- READY/DRAINING/RETIRED/FAILED 生命周期；
- lease/in-flight 引用计数；
- provider health；
- hot reload 旧 generation drain；
- `globalThis.__twinPluginExt` 顺序无关桥接。

### SDK

已扩展 `ctx.twin`：

```js
ctx.twin.registerPhysicsProvider(provider)
ctx.twin.registerScenePack(scenePack)
ctx.twin.registerObjectiveProfile(profile)
ctx.twin.registerTrainingAdapter(adapter)
ctx.twin.registerSolverAdapter(adapter)
ctx.twin.listProviders(filter)
ctx.twin.getProviderHealth(providerId, version)
ctx.twin.resolveProvider(providerId, version)
ctx.twin.validateProvider(providerId, version)
ctx.twin.retireProvider(providerId, version)
```

Registry 不可用时注册请求进入 pending 队列；服务端加载后自动 drain。

### 默认注塑 provider

当前注塑 `InjectionGreyboxProvider` 通过系统启动引导注册为：

```text
plugin: twin-injection-default
provider: injection-greybox-v1@1.0.0
scene pack: injection@1.0.0
```

`server/plugins-builtin/twin-injection-default/index.mjs` 是系统默认插件元数据入口，核心注册通过相同 Registry 完成，避免外置 `.mjs` 直接依赖内部 TypeScript alias。

### 外部场景示例

新增：

```text
.AgentWorkShop/plugins/twin-thermal-demo/index.mjs
```

它只依赖 `ctx.twin`，提供：

- `thermal-demo-v1@1.0.0`；
- `thermal-demo@1.0.0` ScenePack；
- 一阶热过程 `initialize/step/simulate/evaluateConstraints/health`。

不需要修改核心 Twin Tools，即可注册、查询、禁用和重新加载。

### Channel 与 AML lineage

Channel Profile 新增：

```text
providerId
providerVersion
providerHash
scenePackId
providerGeneration
```

AML Job/Model lineage 新增：

```text
providerId
providerVersion
providerHash
providerGeneration
sceneId
sceneVersion
```

模型 metrics 中会保存 `twinProvider` lineage，模型不会因为插件热加载而无提示漂移。

### Provider 目录 API 与 Agent 工具

只读 API：

```text
GET /api/workshop/aml/twin/providers
```

新增 Agent 工具：

```text
twin_provider_catalog
```

用于发现当前 Provider、ScenePack、generation 和 health。

## 热加载语义

1. 新 generation 注册成功后成为可解析版本；
2. 旧 generation 进入 `DRAINING`；
3. 已取得 lease 的 Trial/Job 继续使用旧 provider；
4. lease 释放且 in-flight 归零后旧 generation `RETIRED`；
5. Provider 加载失败时旧版本保持可用；
6. 禁止热加载直接替换 production 模型；
7. 新模型必须重新经过 Twin Gate。

## 验收

已通过：

```text
npm run typecheck
npm run build
npx tsx tests/aml-twin-provider-registry.test.ts
node scripts/test-twin-plugin-sdk.mjs
node scripts/test-plugin-lifecycle.mjs
node scripts/test-sdk-surface.mjs
```

Provider Registry 测试覆盖：

- 注册与 hash；
- 同 generation 幂等；
- generation reload；
- lease/drain；
- retire；
- health failure；
- legacy 注塑 provider；
- global bridge pending replay。

实际运行时已验证：

- Provider catalog 同时看到 `injection-greybox-v1` 与 `thermal-demo-v1`；
- 禁用 thermal plugin 后 Provider 消失；
- 重新启用后 thermal generation 从 `1` 变为 `2`，旧 generation 不影响新 Provider。

## 后续阶段

尚未在本轮实施：

- 通用 FEM/CFD/DEM sidecar；
- ROM 自动生成流水线；
- Provider-specific calibration adapter 自动编排；
- production bounded-auto 的完整 SafetyCase/WriteGrant 流程。

这些能力继续保持：

```text
recommendation-only → shadow → HITL → production
```

不得因为 Provider 热加载而跳过模型门禁或安全审批。
