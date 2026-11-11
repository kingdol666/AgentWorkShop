import { test } from 'node:test'
import assert from 'node:assert/strict'
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
