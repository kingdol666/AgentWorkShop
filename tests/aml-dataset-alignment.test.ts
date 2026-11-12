import { test } from 'node:test'
import assert from 'node:assert/strict'

const { alignSeriesToGridNearest } = await import('../server/services/workshop/aml/dataset-builder')

const G = 1_700_000_000_000
const BEAT = 1_000

test('PR166: offset node samples align to nearest grid point within maxInterpMs', () => {
  const exact = alignSeriesToGridNearest(
    [0, 1, 2, 3].map((value, i) => ({ at: G + i * BEAT, value: 10 + value })),
    G,
    4,
    BEAT,
    250,
  )
  const offset = alignSeriesToGridNearest(
    [0, 1, 2, 3].map((value, i) => ({ at: G + i * BEAT + 200, value: 20 + value })),
    G,
    4,
    BEAT,
    250,
  )
  assert.deepEqual(exact.values, [10, 11, 12, 13])
  assert.deepEqual(offset.values, [20, 21, 22, 23])
  assert.equal(exact.missing, 0)
  assert.equal(offset.missing, 0)
})

test('PR166: exact timestamps win, tolerance boundary is accepted, beyond tolerance is missing', () => {
  const exactWins = alignSeriesToGridNearest(
    [{ at: G + 1_000, value: 101 }, { at: G + 1_200, value: 201 }],
    G + 1_000,
    1,
    BEAT,
    250,
  )
  const boundary = alignSeriesToGridNearest(
    [{ at: G + 250, value: 30 }],
    G,
    1,
    BEAT,
    250,
  )
  const beyond = alignSeriesToGridNearest(
    [{ at: G + 300, value: 40 }],
    G,
    1,
    BEAT,
    250,
  )
  assert.deepEqual(exactWins.values, [101], 'an exact sample must beat a nearby offset sample')
  assert.deepEqual(boundary.values, [30], 'a sample exactly at tolerance remains valid')
  assert.equal(beyond.values[0], Number.NaN, 'a sample beyond tolerance is missing')
  assert.equal(beyond.missing, 1)
})
