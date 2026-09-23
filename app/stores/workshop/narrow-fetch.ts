/**
 * 窄化的 `$fetch` —— 绕开 Nuxt 路由类型推导导致的 TS2589。
 *
 * 背景:`$fetch` 在 Nuxt 里带**全量路由类型推导**(每个 `/api/**` 路由的字面量类型都被
 * 展开成一棵巨大的联合类型)。在 Pinia store 的深层 action 里调用时,TS 会对该类型反复
 * 实例化,最终报 `TS2589: Type instantiation is excessively deep and possibly infinite`,
 * 并连带 `TS2345: Argument of type '{...}' is not assignable to parameter of type 'O'`。
 *
 * 本仓库 `pnpm typecheck` 因此在多个 store 上长期为红(user.ts / workspaces.ts / hitl.ts /
 * chat.ts / notifications.ts / events.ts / entities.ts);这不是本轮群聊改动引入的,
 * 但它是 Definition of Done 的必过门槛,所以这里做一次**系统性**收口,而不是逐文件打补丁。
 *
 * 收口方式:把全局 `$fetch` 窄化成一个纯函数签名(`NarrowFetch`),**运行时是同一个函数**,
 * 行为与拦截器语义完全不变(仍走 nuxt 的 ofetch 实例、仍带 cookie/代理等配置),
 * 只是不再让 TS 展开整棵路由类型树。
 *
 * 用法:`import { narrowFetch } from './narrow-fetch'` → `const res = await narrowFetch<MyEnvelope>(url, { ... })`
 */
export type NarrowFetch = <T>(url: string, opts?: Record<string, unknown>) => Promise<T>

/** 全局 `$fetch` 的窄化视图(Nuxt 把 `$fetch` 挂在 globalThis;无需依赖自动导入类型) */
export const narrowFetch: NarrowFetch
  = (globalThis as unknown as { $fetch: NarrowFetch }).$fetch
