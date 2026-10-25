/**
 * diag-bridge 结果库集成面(结构断言,不 import 插件运行时):
 * 设置键/默认值、3 工具注册、roles 默认、路由、helpers 导出、SDK patch。
 * 对应计划 docs/plans/2026-10-25-idd-results-library-integration.md 验收 A1。
 */
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const pluginSrc = readFileSync('.AgentWorkShop/plugins/diag-bridge/host/plugin.mjs', 'utf8')
const helpersSrc = readFileSync('.AgentWorkShop/plugins/diag-bridge/host/helpers.mjs', 'utf8')
const sdkCtxSrc = readFileSync('sdk/context.mjs', 'utf8')
const sdkTypesSrc = readFileSync('sdk/index.d.mts', 'utf8')
const clientSrc = readFileSync('.AgentWorkShop/plugins/diag-bridge/client.mjs', 'utf8')

test('A1.1 设置:results 组 + 5 键,默认全关/20/4000', () => {
  assert.ok(pluginSrc.includes('id: \'results\''), '缺 results 配置组')
  for (const key of ['results_enabled', 'results_allow_annotate', 'results_allow_worker', 'results_default_limit', 'results_md_max_chars']) {
    assert.ok(pluginSrc.includes(`key: '${key}'`), `缺设置键 ${key}`)
  }
  // 默认值:总开关/编辑/worker 均 false;limit 20;md 4000
  assert.ok(pluginSrc.includes('key: \'results_enabled\', type: \'boolean\', default: false'))
  assert.ok(pluginSrc.includes('key: \'results_allow_annotate\', type: \'boolean\', default: false'))
  assert.ok(pluginSrc.includes('key: \'results_allow_worker\', type: \'boolean\', default: false'))
  assert.ok(pluginSrc.includes('key: \'results_default_limit\', type: \'number\', default: 20, min: 1, max: 200'))
  assert.ok(pluginSrc.includes('key: \'results_md_max_chars\', type: \'number\', default: 4000, min: 500, max: 50000'))
})

test('A1.2 工具:diag_results / diag_result_get / diag_result_annotate 均注册', () => {
  for (const name of ['diag_results', 'diag_result_get', 'diag_result_annotate']) {
    assert.ok(pluginSrc.includes(`name: '${name}'`), `缺工具 ${name}`)
  }
})

test('A1.3 角色默认:读工具走 resultsReadRoles(默认仅 lead);annotate 恒 lead', () => {
  assert.ok(pluginSrc.includes('roles: resultsReadRoles()'), '读工具应使用 resultsReadRoles')
  const annotateBlock = pluginSrc.slice(pluginSrc.indexOf('name: \'diag_result_annotate\''), pluginSrc.indexOf('name: \'diag_result_annotate\'') + 800)
  assert.ok(annotateBlock.includes('roles: [\'lead\']'), 'annotate 必须 lead-only')
  assert.ok(pluginSrc.includes('resultsAllowWorkerOf(ctx) ? [\'lead\', \'worker\'] : [\'lead\']'), '读工具默认收敛到 lead')
})

test('A1.4 关闭态短路:三工具入口都先查 resultsEnabledOf', () => {
  const count = pluginSrc.split('resultsEnabledOf(ctx)) {').length - 1
  assert.ok(count >= 3, `应有至少 3 处关闭态短路(工具+路由),实际 ${count}`)
})

test('A1.5 写面双闸门:annotate 同时要求 results_allow_annotate', () => {
  const annotateBlock = pluginSrc.slice(pluginSrc.indexOf('name: \'diag_result_annotate\''), pluginSrc.indexOf('name: \'diag_result_annotate\'') + 1600)
  assert.ok(annotateBlock.includes('resultsAllowAnnotateOf(ctx)'), 'annotate 必须查 allow_annotate 开关')
})

test('A1.6 路由:results 索引/detail/edit/categories(exact-match,query 传参)', () => {
  for (const decl of ['\'GET\', \'/results\'', '\'GET\', \'/results/detail\'', '\'PATCH\', \'/results/edit\'', '\'GET\', \'/results/categories\'']) {
    assert.ok(pluginSrc.includes(`ctx.route(${decl}`), `缺路由 ${decl}`)
  }
})

test('A1.7 helpers:jpatch/设置读取/探测/错误映射齐备', () => {
  for (const fn of ['jpatch', 'resultsEnabledOf', 'resultsAllowAnnotateOf', 'resultsAllowWorkerOf', 'resultsDefaultLimitOf', 'resultsMdMaxOf', 'probeResults', 'mapResultsError']) {
    assert.ok(helpersSrc.includes(`export ${fn.includes('jpatch') ? 'async function jpatch' : `function ${fn}`}`) || helpersSrc.includes(`export const ${fn}`) || helpersSrc.includes(`export async function ${fn}`), `helpers 缺 ${fn}`)
  }
  assert.ok(helpersSrc.includes('RESULT_FORBIDDEN') && helpersSrc.includes('SUMMARY_READONLY'), '错误映射需覆盖 §16.4')
})

test('A1.8 SDK:ctx.http.patch 已补(context.mjs + 类型)', () => {
  assert.ok(sdkCtxSrc.includes('patch: (url, body, opts2 = {})'), 'context.mjs 缺 patch 实现')
  assert.ok(sdkTypesSrc.includes('patch(url: string, body?'), 'index.d.mts 缺 patch 签名')
})

test('A1.9 客户端:第二面板 diag-results 注册且由 setup 挂载', () => {
  assert.ok(clientSrc.includes('name: \'diag-results\''), '缺 diag-results 面板')
  assert.ok(clientSrc.includes('setupResults(ctx)'), 'setup 需调用 setupResults')
})

test('A1.10 上下文保护:brief 默认 true + md 截断 + 只回 URL', () => {
  const resultsBlock = pluginSrc.slice(pluginSrc.indexOf('name: \'diag_results\''), pluginSrc.indexOf('name: \'diag_result_get\''))
  assert.ok(resultsBlock.includes('brief: args.brief === undefined ? true'), '索引 brief 默认应为 true')
  const getBlock = pluginSrc.slice(pluginSrc.indexOf('name: \'diag_result_get\''), pluginSrc.indexOf('name: \'diag_result_annotate\''))
  assert.ok(getBlock.includes('resultsMdMaxOf(ctx)'), '详情需按设置截断 md')
  assert.ok(getBlock.includes('report_md_url'), '详情需回传报告 URL')
})
