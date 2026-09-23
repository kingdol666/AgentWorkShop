/**
 * 跨阶段共享的可变状态 —— 绑定在本模块内私有,一律经 getX()/setX(v) 访问
 * (由 scripts/three-system-e2e.mjs 按职责拆出;声明与赋值逐行原文搬运)
 *
 * 为什么不 `export let`:跨模块导出可变绑定会被 import/no-mutable-exports 拒绝,
 * 且多模块直接改同一绑定容易失控。故与原脚本 L28/L34/L86/L87/L296-300/L543 一一对应地
 * 提供访问器(命名沿用原标识符,便于逐行对照)。
 */

let LINE = process.env.E2E_LINE ?? 'ln-af002514' // 1号产线(6 个 mock 数采节点)
export function getLINE() {
  return LINE
}
export function setLINE(v) {
  LINE = v
}

/** 插件出站鉴权 token(0c 夹具取得;Stage 1 断言复用) */
let kbTokenG = ''
export function getKbTokenG() {
  return kbTokenG
}
export function setKbTokenG(v) {
  kbTokenG = v
}

// 0. 用户 token / id(持久化演示账号 → env → 现场注册)
let userToken = ''
let userId = ''
export function getUserToken() {
  return userToken
}
export function setUserToken(v) {
  userToken = v
}
export function getUserId() {
  return userId
}
export function setUserId(v) {
  userId = v
}

// Stage 2 产出:团队与工具执行器句柄(Stage 3/4 复用)
let leadA
let toolInvoker // 工具直调执行器(omp;mock lead 不实现 dispatch 面)
let leadB
let channelA
let channelB
export function getLeadA() {
  return leadA
}
export function setLeadA(v) {
  leadA = v
}
export function getToolInvoker() {
  return toolInvoker
}
export function setToolInvoker(v) {
  toolInvoker = v
}
export function getLeadB() {
  return leadB
}
export function setLeadB(v) {
  leadB = v
}
export function getChannelA() {
  return channelA
}
export function setChannelA(v) {
  channelA = v
}
export function getChannelB() {
  return channelB
}
export function setChannelB(v) {
  channelB = v
}

// Stage 3 诊断 runId(汇总提示用)
let runId = ''
export function getRunId() {
  return runId
}
export function setRunId(v) {
  runId = v
}
