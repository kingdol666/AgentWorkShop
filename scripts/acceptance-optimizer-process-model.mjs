#!/usr/bin/env node
/**
 * G6 验收入口(计划命名):用 tsx 的 ESM loader 加载 TS 实现。
 * 直接运行:`node scripts/acceptance-optimizer-process-model.mjs`
 */
import { register } from 'tsx/esm/api'

register()
await import('./acceptance-optimizer-process-model.ts')
