/**
 * 审计实验 1 —— DCW 单节点写在飞互斥 + 周期读互斥(只读:不碰任何源码/数据文件)。
 *
 * 驱动真实 DcwNodeRuntime(dcw-runtime.ts),host 全部打桩,统计同一节点的
 * 并发在飞写/读数;断言心跳重下发(tick)与手动 write() 共享同一 writing 闸门。
 *
 * 运行:node --experimental-transform-types scripts/_audit/run.mjs scripts/_audit/dcw-write-mutex.ts
 */
import { DcwNode } from '../../server/services/workshop/dcw/dcw-node'
import { DcwNodeRuntime } from '../../server/services/workshop/dcw/dcw-runtime'

let failures = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    console.log(`  PASS  ${name}${extra ? ` (${extra})` : ''}`)
  }
  else {
    failures++
    console.log(`  FAIL  ${name}${extra ? ` (${extra})` : ''}`)
  }
}

const statusOf = (e: unknown): string => {
  const s = (e as { status?: number }).status
  return s ? String(s) : `no-status:${(e as Error)?.message ?? String(e)}`
}

interface Stats {
  writeCalls: number
  readCalls: number
  inFlightWrites: number
  maxInFlightWrites: number
  inFlightReads: number
  maxInFlightReads: number
  writeEng: number[]
  concurrentReadPairs: number
}

function makeNode(): DcwNode {
  return DcwNode.fromRow({
    id: 'n-audit-1',
    templateRef: 'cw-temp',
    name: 'audit-node',
    driver: 'mock',
    min: 0,
    max: 200,
    decimals: 2,
    holdIntervalMs: 10,
    readIntervalMs: 1000,
    enabled: true,
    lineId: 'ln-audit',
  })
}

function makeHarness(opts: { writeDelayMs: number, readDelayMs: number }) {
  const stats: Stats = {
    writeCalls: 0,
    readCalls: 0,
    inFlightWrites: 0,
    maxInFlightWrites: 0,
    inFlightReads: 0,
    maxInFlightReads: 0,
    writeEng: [],
    concurrentReadPairs: 0,
  }
  const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
  const host = {
    running: () => true,
    defaults: () => ({ holdIntervalMs: 10, readIntervalMs: 1000 }),
    async executeWrite(node: DcwNode, eng: number) {
      stats.writeCalls++
      stats.writeEng.push(eng)
      stats.inFlightWrites++
      stats.maxInFlightWrites = Math.max(stats.maxInFlightWrites, stats.inFlightWrites)
      await sleep(opts.writeDelayMs)
      stats.inFlightWrites--
      node.applyWriteResult(eng, true, 'stub ok', new Date().toISOString())
      return { ok: true, message: 'stub ok', raw: eng, readback: eng }
    },
    async executeRead() {
      stats.readCalls++
      stats.inFlightReads++
      stats.maxInFlightReads = Math.max(stats.maxInFlightReads, stats.inFlightReads)
      if (stats.inFlightReads > 1)
        stats.concurrentReadPairs++
      await sleep(opts.readDelayMs)
      stats.inFlightReads--
      return { ok: true, value: 1, raw: 1, message: 'stub read', at: new Date().toISOString() }
    },
  }
  return { host, stats }
}

async function main(): Promise<void> {
  // ---------- 场景 A:手动写在飞时,保写心跳必须跳过本拍(不得并发) ----------
  console.log('\n[A] manual write in flight -> tick keep-alive must skip')
  {
    const node = makeNode()
    const { host, stats } = makeHarness({ writeDelayMs: 120, readDelayMs: 0 })
    const rt = new DcwNodeRuntime(node, host as never)
    const p = rt.write(50)
    let tickAt = 1_000_000
    for (let i = 0; i < 20; i++) {
      tickAt += 50 // 远超 holdIntervalMs=10,心跳到点
      rt.tick(tickAt)
    }
    const concurrentSecondWrite = await rt.write(60).then(() => 'resolved', e => `rejected:${statusOf(e)}`)
    const outcome = await p
    check('manual write ok', outcome.ok === true)
    check('heartbeat skipped while manual write in flight (executeWrite called once)', stats.writeCalls === 1, `calls=${stats.writeCalls}`)
    check('max concurrent in-flight writes == 1', stats.maxInFlightWrites === 1, `max=${stats.maxInFlightWrites}`)
    check('second concurrent manual write rejected with 409', concurrentSecondWrite === 'rejected:409', concurrentSecondWrite)
  }

  // ---------- 场景 B:手动写结束后,心跳按节奏重下发且仍与手动写互斥 ----------
  console.log('\n[B] heartbeat re-write shares the same gate')
  {
    const node = makeNode()
    const { host, stats } = makeHarness({ writeDelayMs: 60, readDelayMs: 0 })
    const rt = new DcwNodeRuntime(node, host as never)
    await rt.write(80)
    const callsAfterManual = stats.writeCalls
    const t = 2_000_100
    rt.tick(t) // 到点 -> 心跳下发 node.value
    rt.tick(t) // 同一拍再次 tick:心跳在飞,必须跳过
    await new Promise(r => setTimeout(r, 5))
    const second = await rt.write(90).then(() => 'resolved', e => `rejected:${statusOf(e)}`)
    await new Promise(r => setTimeout(r, 150))
    check('heartbeat issued at least one write', stats.writeCalls > callsAfterManual, `calls=${stats.writeCalls}`)
    check('heartbeat wrote current setpoint 80', stats.writeEng.includes(80), JSON.stringify(stats.writeEng))
    check('manual write during heartbeat in flight rejected with 409', second === 'rejected:409', second)
    check('max concurrent in-flight writes == 1 (whole scenario)', stats.maxInFlightWrites === 1, `max=${stats.maxInFlightWrites}`)
  }

  // ---------- 场景 C:周期读的在飞互斥(readNow 与 tick 读) ----------
  console.log('\n[C] readNow() while periodic read in flight')
  {
    const node = makeNode()
    const { host, stats } = makeHarness({ writeDelayMs: 0, readDelayMs: 120 })
    const rt = new DcwNodeRuntime(node, host as never)
    rt.tick(3_000_000) // 触发周期读(不 await)
    await new Promise(r => setTimeout(r, 10)) // 让周期读进入在飞
    const res = await rt.readNow().then(() => 'resolved', e => `rejected:${statusOf(e)}`)
    await new Promise(r => setTimeout(r, 250))
    check('periodic read started', stats.readCalls >= 1, `readCalls=${stats.readCalls}`)
    check(
      'readNow() rejected (expect rejected:409) while periodic read in flight',
      res === 'rejected:409',
      `actual=${res}; concurrent read pairs=${stats.concurrentReadPairs}, maxInFlightReads=${stats.maxInFlightReads}`,
    )
  }

  console.log(`\nresult: ${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
