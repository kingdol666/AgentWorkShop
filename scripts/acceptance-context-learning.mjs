#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PROFILE_DIR = resolve(ROOT, 'tests/profiles/context')
const FIXTURE_FILE = resolve(ROOT, 'tests/fixtures/context/context-fixtures.json')
const DEFAULT_PROFILE = 'all'
const DEFAULT_MODE = 'simulation'
const DEFAULT_SEED = 'context-learning-default'
const EXIT_PASS = 0
const EXIT_FAIL = 1
const EXIT_BLOCKED = 2
const MODES = new Set(['simulation', 'physical-hil'])
const CAPABILITIES = new Set(['discover', 'snapshot', 'observe', 'query', 'simulate', 'replay', 'verify', 'export'])
const READ_CAPABILITIES = new Set(['discover', 'snapshot', 'observe', 'query', 'replay', 'verify', 'export'])
const DEFAULT_BUDGET = Object.freeze({ maxDurationMs: 60_000, maxSteps: 32, maxBytes: 1_048_576, maxSources: 16, maxOutputBytes: 524_288, maxRsiIterations: 8 })

function stable(value) {
  if (Array.isArray(value)) return value.map(stable)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, nested]) => [key, stable(nested)]))
  }
  return value
}

function canonicalJson(value) {
  return JSON.stringify(stable(value))
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex')
}

function bytes(value) {
  return Buffer.byteLength(canonicalJson(value), 'utf8')
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value)
}

function text(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`)
  return value.trim()
}

function record(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`)
  return value
}

function array(value, name) {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`)
  return value
}

function parseArgs(argv) {
  const options = { profile: DEFAULT_PROFILE, mode: DEFAULT_MODE, seed: DEFAULT_SEED, noNetwork: false, report: undefined, baseline: undefined, help: false }
  const valueOptions = new Set(['profile', 'mode', 'report', 'baseline', 'seed'])
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === '--no-network') {
      options.noNetwork = true
      continue
    }
    if (!argument.startsWith('--')) throw new Error(`unknown argument ${argument}`)
    const equal = argument.indexOf('=')
    const key = equal === -1 ? argument.slice(2) : argument.slice(2, equal)
    if (!valueOptions.has(key)) throw new Error(`unknown option --${key}`)
    const value = equal === -1 ? argv[++index] : argument.slice(equal + 1)
    if (!value || value.startsWith('--')) throw new Error(`option --${key} requires a value`)
    options[key] = value
  }
  return options
}

function usage() {
  return [
    'Usage: node scripts/acceptance-context-learning.mjs [options]',
    '',
    `  --profile <name|path>  Context profile (default: ${DEFAULT_PROFILE})`,
    `  --mode <simulation|physical-hil>  Execution classification (default: ${DEFAULT_MODE})`,
    '  --report <path>        Write the deterministic JSON report',
    '  --baseline <path>      Compare acceptanceFingerprint with a prior report',
    `  --seed <value>         Deterministic candidate ID seed (default: ${DEFAULT_SEED})`,
    '  --no-network           Disable network work (fixture adapters are offline)',
    '  --help                 Show this help',
  ].join('\n')
}

function profilePath(value) {
  if (isAbsolute(value) || value.includes('/') || value.includes('\\') || extname(value) === '.json') return resolve(process.cwd(), value)
  return resolve(PROFILE_DIR, `${value}.json`)
}

function loadJson(path, name) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  }
  catch (error) {
    throw new Error(`cannot read ${name} ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  return record(parsed, name)
}

function validateProfile(profile) {
  text(profile.id, 'profile.id')
  text(profile.fixtureId, 'profile.fixtureId')
  const adapter = record(profile.adapter, 'profile.adapter')
  text(adapter.id, 'profile.adapter.id')
  text(adapter.version, 'profile.adapter.version')
  if (!['none', 'candidate-only'].includes(adapter.sideEffect)) throw new Error('profile.adapter.sideEffect must be none or candidate-only')
  const capabilities = array(adapter.capabilities, 'profile.adapter.capabilities')
  if (capabilities.length === 0 || capabilities.some(capability => !CAPABILITIES.has(capability))) throw new Error('profile.adapter.capabilities contains an unsupported capability')
  const research = record(profile.research, 'profile.research')
  text(research.objective, 'profile.research.objective')
  text(research.question, 'profile.research.question')
  const steps = array(research.steps, 'profile.research.steps')
  if (steps.length === 0) throw new Error('profile.research.steps must not be empty')
  const budget = { ...DEFAULT_BUDGET, ...(research.budget ?? {}) }
  for (const [key, value] of Object.entries(budget)) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`profile.research.budget.${key} must be a positive integer`)
  }
  if (steps.length > budget.maxSteps) throw new Error('profile.research.steps exceeds maxSteps')
  const acceptance = record(profile.acceptance ?? {}, 'profile.acceptance')
  if (acceptance.expectedClassification && !MODES.has(acceptance.expectedClassification)) throw new Error('profile.acceptance.expectedClassification is not a supported mode')
  return { ...profile, adapter: { ...adapter, capabilities: [...capabilities] }, research: { ...research, steps: [...steps], budget }, acceptance }
}

function loadProfile(value) {
  const path = profilePath(value)
  const profile = validateProfile(loadJson(path, 'profile'))
  return { profile, path }
}

function loadFixture(profile) {
  const fixtures = record(loadJson(FIXTURE_FILE, 'context fixture file').fixtures, 'context fixture file fixtures')
  const fixture = fixtures[profile.fixtureId]
  if (!fixture) throw new Error(`fixture ${profile.fixtureId} is not defined`)
  const output = record(fixture, `fixture ${profile.fixtureId}`)
  text(output.capturedAt, `fixture ${profile.fixtureId}.capturedAt`)
  text(output.sourceRef, `fixture ${profile.fixtureId}.sourceRef`)
  return output
}

function contextRef(namespace, id) {
  return { namespace, id }
}

function provenance(profile, fixture) {
  return [{ adapterId: profile.adapter.id, sourceRef: fixture.sourceRef, sourceRevision: fixture.revision, capturedAt: fixture.capturedAt, contentHash: hash(fixture) }]
}

function selectionIds(selection, key, values) {
  const selected = selection?.[key]
  if (!selected) return new Set(values.map(item => item.id))
  return new Set(array(selected, `profile.context.${key}`).map(item => text(item, `profile.context.${key} item`)))
}

function buildContextSnapshot(profile, fixture) {
  const context = record(profile.context ?? {}, 'profile.context')
  const fixtureSubjects = array(fixture.subjects ?? [], 'fixture.subjects')
  const fixtureObjects = array(fixture.objects ?? [], 'fixture.objects')
  const fixtureAttributes = array(fixture.attributes ?? [], 'fixture.attributes')
  const fixtureMaterials = array(fixture.materials ?? [], 'fixture.materials')
  const subjectIds = selectionIds(context, 'subjectIds', fixtureSubjects)
  const objectIds = selectionIds(context, 'objectIds', fixtureObjects)
  const selectedObjects = fixtureObjects.filter(item => objectIds.has(item.id))
  for (const object of selectedObjects) if (!subjectIds.has(object.subjectId)) subjectIds.add(object.subjectId)
  const selectedSubjects = fixtureSubjects.filter(item => subjectIds.has(item.id))
  const selectedAttributeIds = selectionIds(context, 'attributeIds', fixtureAttributes)
  const selectedAttributes = fixtureAttributes.filter(item => selectedAttributeIds.has(item.id) && (objectIds.has(item.ownerId) || subjectIds.has(item.ownerId)))
  const selectedMaterialIds = selectionIds(context, 'materialIds', fixtureMaterials)
  const selectedMaterials = fixtureMaterials.filter(item => selectedMaterialIds.has(item.id) && (subjectIds.has(item.targetId) || objectIds.has(item.targetId)))
  const subjectRefById = new Map(selectedSubjects.map(item => [item.id, contextRef('context.subject', item.id)]))
  const objectRefById = new Map(selectedObjects.map(item => [item.id, contextRef('context.object', item.id)]))
  const attributeRefById = new Map(selectedAttributes.map(item => [item.id, contextRef('context.attribute', item.id)]))
  const materialRefById = new Map(selectedMaterials.map(item => [item.id, contextRef('context.material', item.id)]))
  const sourceProvenance = provenance(profile, fixture)
  const scope = {
    ...(fixture.workspaceId ? { workspaceId: fixture.workspaceId } : {}),
    ...(context.tags ? { tags: [...array(context.tags, 'profile.context.tags')] } : {}),
    ...(context.timeWindow ? { timeWindow: clone(context.timeWindow) } : {}),
    ...(context.scope ? clone(record(context.scope, 'profile.context.scope')) : {}),
  }
  const subjects = selectedSubjects.map(item => ({
    ref: subjectRefById.get(item.id),
    subjectType: text(item.type, 'fixture subject.type'),
    label: text(item.label, 'fixture subject.label'),
    scope,
    status: item.status ?? 'active',
    ...(item.extensionData ? { extensionData: clone(item.extensionData) } : {}),
    provenance: clone(sourceProvenance),
  }))
  const attributes = selectedAttributes.map(item => ({
    ref: attributeRefById.get(item.id),
    ownerRef: objectRefById.get(item.ownerId) ?? subjectRefById.get(item.ownerId),
    key: text(item.key, 'fixture attribute.key'),
    value: clone(item.value),
    valueKind: item.valueKind ?? 'scalar',
    ...(item.unit ? { unit: item.unit } : {}),
    ...(item.semanticType ? { semanticType: item.semanticType } : {}),
    accessMode: item.accessMode ?? 'observe',
    quality: item.quality ?? 'raw',
    provenance: clone(sourceProvenance),
  }))
  const objects = selectedObjects.map(item => ({
    ref: objectRefById.get(item.id),
    objectType: text(item.type, 'fixture object.type'),
    subjectRefs: [subjectRefById.get(item.subjectId)],
    ...(item.role ? { role: item.role } : {}),
    attributes: selectedAttributes.filter(attribute => attribute.ownerId === item.id).map(attribute => attributeRefById.get(attribute.id)),
    ...(item.extensionData ? { extensionData: clone(item.extensionData) } : {}),
    provenance: clone(sourceProvenance),
  }))
  const materialAssignments = selectedMaterials.map(item => ({
    ref: materialRefById.get(item.id),
    materialRef: contextRef('context.material-object', item.materialId ?? item.id),
    targetRefs: [objectRefById.get(item.targetId) ?? subjectRefById.get(item.targetId)],
    assignmentRole: text(item.role ?? 'input', 'fixture material.role'),
    ...(item.quantity ? { quantity: clone(item.quantity) } : {}),
    status: item.status ?? 'active',
    provenance: clone(sourceProvenance),
  }))
  const knownRef = id => objectRefById.get(id) ?? subjectRefById.get(id) ?? attributeRefById.get(id) ?? materialRefById.get(id)
  const relations = array(fixture.relations ?? [], 'fixture.relations')
    .filter(item => knownRef(item.srcId) && knownRef(item.dstId))
    .map(item => ({ id: text(item.id, 'fixture relation.id'), kind: text(item.kind, 'fixture relation.kind'), src: knownRef(item.srcId), dst: knownRef(item.dstId), evidenceRefs: [] }))
  const content = {
    id: `context-snapshot-${profile.id}`,
    scope: {
      ...scope,
      ...(subjects.length ? { subjectRefs: subjects.map(subject => subject.ref) } : {}),
      ...(objects.length ? { objectRefs: objects.map(object => object.ref) } : {}),
      ...(attributes.length ? { attributeRefs: attributes.map(attribute => attribute.ref) } : {}),
      ...(materialAssignments.length ? { materialAssignmentRefs: materialAssignments.map(assignment => assignment.ref) } : {}),
    },
    subjects,
    objects,
    attributes,
    materialAssignments,
    relations,
    schemaRefs: clone(context.schemaRefs ?? [{ extensionId: 'context-learning-fixture', version: '1.0.0' }]),
    adapterRefs: [{ adapterId: profile.adapter.id, version: profile.adapter.version }],
    createdAt: fixture.capturedAt,
  }
  return { ...content, contentHash: hash(content) }
}

function validateSnapshot(snapshot) {
  const { contentHash, ...content } = snapshot
  const errors = []
  if (hash(content) !== contentHash) errors.push('context snapshot contentHash does not match canonical content')
  if (!snapshot.id || !snapshot.createdAt || !Array.isArray(snapshot.subjects) || !Array.isArray(snapshot.objects) || !Array.isArray(snapshot.attributes)) errors.push('context snapshot is incomplete')
  const known = new Set([
    ...snapshot.subjects.map(item => `${item.ref.namespace}:${item.ref.id}`),
    ...snapshot.objects.map(item => `${item.ref.namespace}:${item.ref.id}`),
    ...snapshot.attributes.map(item => `${item.ref.namespace}:${item.ref.id}`),
    ...snapshot.materialAssignments.map(item => `${item.ref.namespace}:${item.ref.id}`),
  ])
  for (const object of snapshot.objects) for (const ref of [...object.subjectRefs, ...object.attributes]) if (!known.has(`${ref.namespace}:${ref.id}`)) errors.push(`dangling object reference ${ref.namespace}:${ref.id}`)
  for (const attribute of snapshot.attributes) if (!attribute.ownerRef || !known.has(`${attribute.ownerRef.namespace}:${attribute.ownerRef.id}`)) errors.push(`dangling attribute owner ${attribute.ref.id}`)
  return errors
}

function normalizeBudget(research) {
  return { ...DEFAULT_BUDGET, ...(research.budget ?? {}) }
}

function outputFor(step, profile, fixture, snapshot, index) {
  const common = { adapterId: profile.adapter.id, capability: step.capability, sourceRef: step.sourceRef, fixtureId: profile.fixtureId, snapshotId: snapshot.id, snapshotHash: snapshot.contentHash }
  const builders = {
    snapshot: () => ({ ...common, result: 'context-snapshot', subjectCount: snapshot.subjects.length, objectCount: snapshot.objects.length }),
    simulate: () => ({ ...common, result: 'projected-simulation', classification: 'simulation', applied: false, physicalHIL: false }),
    discover: () => ({ ...common, result: 'discovery', available: true, records: fixture.objects?.length ?? 0 }),
    query: () => ({ ...common, result: 'fixture-query', records: fixture.attributes?.length ?? 0 }),
    observe: () => ({ ...common, result: 'fixture-observation', capturedAt: fixture.capturedAt }),
    replay: () => ({ ...common, result: 'fixture-replay', replayed: false }),
    verify: () => ({ ...common, result: 'fixture-verification', verified: true }),
    export: () => ({ ...common, result: 'fixture-export', format: 'json', exported: false }),
  }
  const builder = builders[step.capability]
  if (!builder) throw new Error(`unsupported research capability ${step.capability}`)
  return { index, ...builder() }
}

function candidateFor(step, result, profile, runId, seed, index, fixture) {
  const payloadHash = hash(result)
  const id = `evidence-candidate-${hash({ seed, profile: profile.id, runId, step: step.id, index }).slice(0, 24)}`
  const envelope = {
    id,
    kind: step.kind ?? (step.capability === 'simulate' ? 'simulation' : 'observation'),
    subjectRefs: [{ namespace: 'context.subject', id: fixture.subjects?.[0]?.id ?? 'global' }],
    researchRunId: runId,
    source: { adapterId: profile.adapter.id, sourceRef: `${step.sourceRef}#${index}`, sourceRevision: fixture.revision },
    payloadRef: `fixture://${profile.fixtureId}/${runId}/${step.id}/${index}`,
    payloadHash,
    quality: step.quality ?? 'raw',
    claimLevel: 'candidate',
    accessScope: { workspaceId: fixture.workspaceId, tags: ['context-learning', profile.id] },
    createdAt: fixture.capturedAt,
    candidateOnly: true,
    classification: step.capability === 'simulate' ? 'simulation' : 'fixture-observation',
  }
  return { ...envelope, contentHash: hash(envelope) }
}

function runResearch(profile, fixture, snapshot, options) {
  const research = profile.research
  const budget = normalizeBudget(research)
  const runId = `research-run-${profile.id}`
  const steps = research.steps.map((step, index) => {
    const current = record(step, `profile.research.steps[${index}]`)
    text(current.id, `profile.research.steps[${index}].id`)
    text(current.sourceRef, `profile.research.steps[${index}].sourceRef`)
    if (!CAPABILITIES.has(current.capability) || !profile.adapter.capabilities.includes(current.capability)) throw new Error(`research step ${current.id} uses unavailable capability ${current.capability}`)
    if (current.capability === 'actuate' || current.capability === 'write') throw new Error(`research step ${current.id} attempts a control-path operation`)
    if (current.network === true && options.noNetwork) throw new Error(`research step ${current.id} requires network while --no-network is active`)
    return current
  })
  const plannedBytes = steps.reduce((total, step) => total + bytes(step.payload ?? {}), 0)
  const sourceCount = new Set(steps.map(step => `${profile.adapter.id}:${step.sourceRef}:${step.sourceRevision ?? ''}`)).size
  const rsiIterations = steps.reduce((max, step) => Math.max(max, step.rsiIteration ?? 0), 0)
  const counters = { steps: steps.length, bytes: plannedBytes, sources: sourceCount, outputBytes: 0, rsiIterations }
  if (counters.steps > budget.maxSteps || counters.bytes > budget.maxBytes || counters.sources > budget.maxSources || counters.rsiIterations > budget.maxRsiIterations) throw new Error('research plan exceeds its bounded budget')
  const evidence = []
  const outputs = []
  for (const [index, step] of steps.entries()) {
    const result = outputFor(step, profile, fixture, snapshot, index)
    counters.outputBytes += bytes(result)
    if (counters.outputBytes > budget.maxOutputBytes) throw new Error('research output exceeds its bounded budget')
    outputs.push({ stepId: step.id, capability: step.capability, sourceRef: step.sourceRef, bytes: bytes(result) })
    evidence.push(candidateFor(step, result, profile, runId, options.seed, index, fixture))
  }
  return {
    id: runId,
    state: 'completed',
    objective: research.objective,
    question: research.question,
    budget,
    counters,
    plan: steps.map((step, index) => ({ id: step.id, adapterId: profile.adapter.id, capability: step.capability, sourceRef: step.sourceRef, kind: step.kind ?? (step.capability === 'simulate' ? 'simulation' : 'observation'), bytes: bytes(step.payload ?? {}), outputBytes: outputs[index].bytes })),
    verdict: { summary: 'bounded fixture research completed; evidence remains candidate-only', claimLevel: 'candidate', evidenceIds: evidence.map(item => item.id) },
    evidenceIds: evidence.map(item => item.id),
    evidence,
    outputs,
  }
}

function executionFor(mode) {
  const physicalHIL = { requested: mode === 'physical-hil', executed: false, verified: false, claim: false, status: 'not-available' }
  return {
    mode,
    classification: mode,
    simulation: mode === 'simulation',
    physicalHIL,
    network: { disabled: false, calls: 0 },
  }
}

function sideEffectsFor(profile, research, noNetwork) {
  const simulationOperations = research.plan.filter(step => step.capability === 'simulate').length
  const readOperations = research.plan.filter(step => READ_CAPABILITIES.has(step.capability)).length
  const candidateEvidenceWrites = research.evidenceIds.length
  return {
    adapter: { adapterId: profile.adapter.id, sideEffect: profile.adapter.sideEffect, invocations: research.plan.length },
    counters: {
      readOperations,
      simulationOperations,
      candidateEvidenceWrites,
      physicalWrites: 0,
      controlPathWrites: 0,
      networkCalls: 0,
      networkDisabled: noNetwork,
    },
    physicalHIL: { invocations: 0, verified: false, claim: false },
  }
}

function checkAcceptance(profile, snapshot, research, sideEffects, execution) {
  const errors = validateSnapshot(snapshot)
  const acceptance = profile.acceptance
  if (acceptance.expectedClassification && acceptance.expectedClassification !== execution.classification) errors.push(`expected classification ${acceptance.expectedClassification}, got ${execution.classification}`)
  if (acceptance.maxCandidateEvidence !== undefined && research.evidenceIds.length > acceptance.maxCandidateEvidence) errors.push('candidate evidence count exceeds profile bound')
  if (acceptance.requireNoPhysicalWrites !== false && sideEffects.counters.physicalWrites !== 0) errors.push('physical writes were observed')
  for (const evidenceId of research.evidenceIds) {
    const evidence = research.evidenceById?.[evidenceId]
    if (evidence && (evidence.candidateOnly !== true || evidence.claimLevel !== 'candidate')) errors.push(`evidence ${evidenceId} is not candidate-only`)
  }
  return errors
}

function fingerprint(report) {
  return hash({
    reportVersion: report.reportVersion,
    profile: report.profile,
    fixture: report.fixture,
    execution: report.execution,
    contextSnapshot: { id: report.contextSnapshot.id, contentHash: report.contextSnapshot.contentHash },
    research: { counters: report.research.counters, evidenceIds: report.research.evidenceIds, evidenceHashes: report.candidateEvidence.map(item => item.contentHash) },
    sideEffects: report.sideEffects,
  })
}

function compareBaseline(report, baselinePath) {
  if (!baselinePath) return { provided: false, matched: null }
  const baseline = loadJson(resolve(process.cwd(), baselinePath), 'baseline report')
  const expected = baseline.acceptanceFingerprint ?? baseline.summary?.acceptanceFingerprint
  if (typeof expected !== 'string' || expected.length === 0) throw new Error('baseline report does not contain acceptanceFingerprint')
  return { provided: true, matched: expected === report.acceptanceFingerprint, path: baselinePath }
}

function writeReport(path, report) {
  if (!path) return
  const target = resolve(process.cwd(), path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

export function runAcceptance(options) {
  const { profile } = loadProfile(options.profile)
  const fixture = loadFixture(profile)
  const snapshot = buildContextSnapshot(profile, fixture)
  const execution = executionFor(options.mode)
  execution.network.disabled = options.noNetwork
  if (options.mode === 'physical-hil') {
    const report = {
      reportVersion: 'context-learning.acceptance.v1',
      profile: { id: profile.id, fixtureId: profile.fixtureId },
      fixture: { id: profile.fixtureId, revision: fixture.revision, capturedAt: fixture.capturedAt },
      execution,
      contextSnapshot: snapshot,
      research: { id: `research-run-${profile.id}`, state: 'blocked', counters: { steps: 0, bytes: 0, sources: 0, outputBytes: 0, rsiIterations: 0 }, evidenceIds: [], verdict: null },
      candidateEvidence: [],
      sideEffects: { adapter: { adapterId: profile.adapter.id, sideEffect: profile.adapter.sideEffect, invocations: 0 }, counters: { readOperations: 0, simulationOperations: 0, candidateEvidenceWrites: 0, physicalWrites: 0, controlPathWrites: 0, networkCalls: 0, networkDisabled: options.noNetwork }, physicalHIL: { invocations: 0, verified: false, claim: false } },
      acceptance: { status: 'BLOCKED', errors: ['physical-HIL is not available in this runner; no physical-HIL claim is made'] },
      baseline: { provided: false, matched: null },
    }
    report.acceptanceFingerprint = fingerprint(report)
    return { report, exitCode: EXIT_BLOCKED }
  }
  const research = runResearch(profile, fixture, snapshot, options)
  const candidateEvidence = research.evidence
  research.evidenceById = Object.fromEntries(candidateEvidence.map(item => [item.id, item]))
  const sideEffects = sideEffectsFor(profile, research, options.noNetwork)
  const acceptanceErrors = checkAcceptance(profile, snapshot, research, sideEffects, execution)
  const report = {
    reportVersion: 'context-learning.acceptance.v1',
    profile: { id: profile.id, fixtureId: profile.fixtureId },
    fixture: { id: profile.fixtureId, revision: fixture.revision, capturedAt: fixture.capturedAt },
    seed: options.seed,
    execution,
    contextSnapshot: snapshot,
    research: { ...research, evidence: undefined, evidenceById: undefined },
    candidateEvidence,
    sideEffects,
    acceptance: { status: acceptanceErrors.length ? 'FAIL' : 'PASS', errors: acceptanceErrors },
    baseline: { provided: false, matched: null },
  }
  report.acceptanceFingerprint = fingerprint(report)
  const baseline = compareBaseline(report, options.baseline)
  report.baseline = baseline
  if (baseline.provided && !baseline.matched) {
    report.acceptance.status = 'FAIL'
    report.acceptance.errors.push('acceptanceFingerprint does not match baseline')
  }
  return { report, exitCode: report.acceptance.status === 'PASS' ? EXIT_PASS : EXIT_FAIL }
}

async function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
    if (options.help) {
      console.log(usage())
      return
    }
    if (!MODES.has(options.mode)) throw new Error(`--mode must be one of ${[...MODES].join(', ')}`)
    text(options.seed, '--seed')
    const result = runAcceptance(options)
    writeReport(options.report, result.report)
    console.log(`CONTEXT_ACCEPTANCE status=${result.report.acceptance.status} profile=${result.report.profile.id} mode=${result.report.execution.classification} exit=${result.exitCode}`)
    if (options.report) console.log(`report=${resolve(process.cwd(), options.report)}`)
    process.exitCode = result.exitCode
  }
  catch (error) {
    console.error(`CONTEXT_ACCEPTANCE status=ERROR exit=${EXIT_BLOCKED} message=${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = EXIT_BLOCKED
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main()
