import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { AepDaqFrame } from '../shared/daq-protocol'

test('AepDaqFrame preserves line provenance as an optional nullable lineId', () => {
  const frame: AepDaqFrame = {
    nodeId: 'daq-1',
    templateRef: 'thickness-scan',
    kind: 'vector',
    at: new Date(0).toISOString(),
    lineId: 'line-1',
    preview: [0.5],
  }
  assert.equal(frame.lineId, 'line-1')
  const unbound: AepDaqFrame = { ...frame, lineId: null }
  assert.equal(unbound.lineId, null)
})

test('DAQ frame frontend preserves nullable lineId from REST and WS paths', () => {
  const source = readFileSync('app/composables/workshop/useDaqStream.ts', 'utf8')
  assert.match(source, /lineId: string \| null/)
  assert.match(source, /lineId: p\.lineId \?\? null/)
  assert.match(source, /lineId: frame\.lineId \?\? null/)
})
