/**
 * `--import` 入口:把 TS 解析钩子注册为 Node ESM loader。
 *
 * 用途:纯 node 直接运行 server 侧 .ts 回归脚本(Node 24 内建类型擦除):
 *   node --import ./scripts/_audit/ts-register-hook.mjs scripts/<suite>.ts
 *
 * 与 `register(new URL('./ts-resolve-hook.mjs', ...))` 的 .mjs 包装脚本等价;
 * 单独成文件是为了让 `--import`(只执行、不注册)也能生效,避免钩子被注册两次。
 */
import { register } from 'node:module'

register(new URL('./ts-resolve-hook.mjs', import.meta.url).href)
