import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = join(import.meta.dirname, '..')
const coreFiles = [
  'shared/context/contracts.ts',
  'shared/context/refs.ts',
  'shared/context/hash.ts',
  'server/services/workshop/context/contracts.ts',
  'server/services/workshop/context/validator.ts',
  'server/services/workshop/context/errors.ts',
]

const forbiddenDomainTerms = /\b(?:pva|wwtp|injection|production[_ -]?line|lineId|productId|recipeId|runId)\b/i

test('core context contracts remain domain-neutral', async () => {
  for (const relativePath of coreFiles) {
    const source = await readFile(join(root, relativePath), 'utf8')
    assert.equal(forbiddenDomainTerms.test(source), false, `${relativePath} contains a domain-specific core term`)
  }
})

test('core semantics use open strings rather than domain-closed enums', async () => {
  const source = await readFile(join(root, 'shared/context/contracts.ts'), 'utf8')
  assert.match(source, /subjectType:\s*nonEmptyKey/)
  assert.match(source, /objectType:\s*nonEmptyKey/)
  assert.match(source, /assignmentRole:\s*nonEmptyKey/)
  assert.match(source, /kind:\s*nonEmptyKey/)
  assert.doesNotMatch(source, /z\.enum\(\[[^\]]*(?:line|product|recipe|run)/i)
})

test('generic research and evidence contracts do not require a physical device identifier', async () => {
  const source = await readFile(join(root, 'shared/context/contracts.ts'), 'utf8')
  const researchSection = source.slice(source.indexOf('export const researchCaseSchema'))
  assert.doesNotMatch(researchSection, /\b(?:lineId|productId|recipeId|plc|daq|dcw)\b/i)
  assert.match(researchSection, /contextSnapshotId/)
  assert.match(researchSection, /accessScope/)
})
