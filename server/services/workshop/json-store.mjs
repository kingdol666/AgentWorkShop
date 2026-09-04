// ============================================================
// JSON 文件存储原语 —— 全部 JSON 仓库共用(hardening:防数据丢失)。
//
// 背景(2026-09-05 QA 审计 P0-2):各仓库原先直接 writeFileSync 落盘 +
// load 时 catch 后静默返回空库。一次写入中断(崩溃/断电/磁盘满)即产生
// 截断文件,下次启动静默以空库运行,首次落盘用空数据覆盖原文件 ——
// recipes/产线配置/回滚锚点永久丢失。
//
// 约定:
//  - loadJsonFile:损坏时把坏文件保留为 <name>.corrupt-<ts>(现场可追责),
//    再返回 fallback;ENOTDIR/ENOENT 等缺失场景静默 fallback。
//  - saveJsonFileAtomic:先写同目录临时文件再 rename(同卷原子替换);
//    rename 失败(Windows 杀软占用等)退回直写,保证可用性。
// ============================================================
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 读取 JSON 文件;缺失或损坏时返回 fallback。
 * @param {string} filePath
 * @param {unknown} fallback 缺省结构(如 { anchors: [], records: [] } 或 [])
 * @returns
 */
export function loadJsonFile(filePath, fallback) {
  let raw
  try {
    raw = readFileSync(filePath, 'utf-8')
  }
  catch {
    return fallback
  }
  try {
    return JSON.parse(raw)
  }
  catch (err) {
    // 损坏现场保留:改名留档,绝不用空库静默顶替用户数据
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = `${filePath}.corrupt-${stamp}`
    try {
      renameSync(filePath, backupPath)
      console.error(`[json-store] ⚠ ${filePath} 解析失败(${err.message}),坏文件已保留为 ${backupPath},本次以空数据启动`)
    }
    catch {
      console.error(`[json-store] ⚠ ${filePath} 解析失败(${err.message}),且保留坏文件失败,本次以空数据启动`)
    }
    return fallback
  }
}

/**
 * 原子落盘:写临时文件 → rename 替换;失败退回直写。
 * @param {string} filePath
 * @param {unknown} data
 */
export function saveJsonFileAtomic(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}`
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8')
    try {
      renameSync(tmp, filePath)
      return
    }
    catch {
      // rename 失败(目标被占用等):退回直写,可用性优先
    }
  }
  catch (tmpErr) {
    console.error(`[json-store] 临时文件写入失败(${tmpErr.message}),退回直写`)
  }
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8')
}
