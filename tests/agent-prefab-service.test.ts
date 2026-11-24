/**
 * AgentPrefab service 回归：草稿校验、profile 白名单、发布/绑定、权限与 slot 严格校验。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openWorkshopDb } from '../server/services/workshop/db/database/open'
import { createAgentPrefabService, parseAgentPrefabBinding, validatePrefabDraft } from '../server/services/workshop/agent-prefabs/service'

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Expert',
    description: '',
    visibility: 'private',
    prompt: {
      role: 'role',
      scenario: 'scenario',
      slots: [{ key: 'goal', label: 'Goal', required: true, defaultValue: 'stable', allowMemberOverride: true, maxLength: 50 }],
    },
    profile: { provider: 'omp', model: 'm1', settings: { thinkingLevel: 'high' } },
    capabilities: [{ kind: 'tool', id: 'daq_query', required: true }],
    ...overrides,
  }
}

const expectCode = (code: string) => (err: { code?: string }) => {
  assert.equal(err.code, code)
  return true
}

test('validates draft shape, names and forbidden profile keys', () => {
  assert.equal(validatePrefabDraft(draft()).name, 'Expert')
  assert.throws(() => validatePrefabDraft(draft({ name: '' })), expectCode('VALIDATION_ERROR'))
  assert.throws(() => validatePrefabDraft(draft({ profile: { settings: { command: 'sh' } } })), expectCode('VALIDATION_ERROR'))
  assert.throws(() => validatePrefabDraft(draft({ profile: { settings: { token: 'x' } } })), expectCode('VALIDATION_ERROR'))
  assert.throws(() => validatePrefabDraft(draft({ capabilities: [{ kind: 'other', id: 'x' }] })), expectCode('VALIDATION_ERROR'))
  assert.throws(() => validatePrefabDraft(draft({ capabilities: [{ kind: 'tool', id: 'a' }, { kind: 'tool', id: 'a' }] })), expectCode('VALIDATION_ERROR'))
  assert.throws(
    () => validatePrefabDraft(draft({ prompt: { slots: [{ key: 'Bad Key', label: 'x' }] } })),
    expectCode('VALIDATION_ERROR'),
  )
})

test('publish/bind validates revision slots and permission', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const service = createAgentPrefabService(db)
    const owner = { id: 'u1', role: 'user' }
    const row = service.create(owner, draft())
    const revision = service.publish(owner, row.id, 0)
    assert.equal(revision.revision, 1)

    const binding = service.buildBinding(owner, row.id, 1, { goal: 'grow' })
    assert.deepEqual(binding.slotValues, { goal: 'grow' })
    assert.equal(binding.contentHash, revision.contentHash)
    assert.deepEqual(parseAgentPrefabBinding(JSON.stringify(binding)), binding)

    assert.throws(
      () => service.buildBinding(owner, row.id, 1, { goal: '', extra: 'x' }),
      expectCode('VALIDATION_ERROR'),
    )
    assert.throws(
      () => service.buildBinding({ id: 'u2', role: 'user' }, row.id, 1, { goal: 'x' }),
      expectCode('PREFAB_FORBIDDEN'),
    )
  }
  finally {
    db.close()
  }
})

test('visibility: private only owner/admin, public readable', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const service = createAgentPrefabService(db)
    const owner = { id: 'u1', role: 'user' }
    const privateRow = service.create(owner, draft())
    assert.equal(service.list(owner).length, 1)
    assert.equal(service.list({ id: 'u2', role: 'user' }).length, 0)
    assert.equal(service.list({ id: 'admin', role: 'admin' }).length, 1)
    assert.throws(() => service.get({ id: 'u2', role: 'user' }, privateRow.id), (err: { status?: number }) => err.status === 403)

    const publicRow = service.create(owner, draft({ visibility: 'public' }))
    assert.equal(service.list({ id: 'u2', role: 'user' }).some(r => r.id === publicRow.id), true)
    assert.throws(
      () => service.update({ id: 'u2', role: 'user' }, publicRow.id, publicRow.updatedAt, draft()),
      (err: { status?: number }) => err.status === 403,
    )
  }
  finally {
    db.close()
  }
})

test('delete checks the saved draft; archiving keeps immutable pins but denies new bindings', () => {
  const db = openWorkshopDb(':memory:')
  try {
    const service = createAgentPrefabService(db)
    const owner = { id: 'u1' }
    const reader = { id: 'u2' }
    const first = service.create(owner, draft({ visibility: 'public' }))
    assert.throws(() => service.remove(reader, first.id, first.updatedAt), expectCode('PREFAB_OWNER_REQUIRED'))
    const edited = service.update(owner, first.id, first.updatedAt, draft({ name: 'Edited', visibility: 'public' }))
    assert.throws(() => service.remove(owner, first.id, first.updatedAt), expectCode('PREFAB_EDIT_CONFLICT'))
    assert.throws(() => service.publish(owner, first.id, 0, first.updatedAt), expectCode('PREFAB_EDIT_CONFLICT'))
    const published = service.publish(owner, first.id, 0, edited.updatedAt)
    const binding = service.buildBinding(reader, first.id, 1, {})
    assert.equal(binding.contentHash, published.contentHash)
    assert.throws(() => service.remove(owner, first.id, edited.updatedAt), expectCode('PREFAB_EDIT_CONFLICT'))
    assert.deepEqual(service.remove(owner, first.id, service.get(owner, first.id).updatedAt), { id: first.id, archived: true })
    assert.equal(service.list(reader).length, 0)
    assert.equal(service.list({ id: 'admin', role: 'admin' }).length, 0)
    const archived = service.get(reader, first.id)
    assert.ok(archived.archivedAt)
    assert.equal(service.loadRevision(first.id, 1)?.revision.contentHash, binding.contentHash)
    assert.throws(() => service.buildBinding(reader, first.id, 1, {}), expectCode('PREFAB_ARCHIVED'))
    assert.throws(() => service.buildBinding({ kind: 'channel-lead', channelOwnerUserId: owner.id }, first.id, 1, {}), expectCode('PREFAB_ARCHIVED'))
    assert.throws(() => service.update(owner, first.id, archived.updatedAt, draft()), expectCode('PREFAB_ARCHIVED'))
    assert.throws(() => service.publish(owner, first.id, 1, archived.updatedAt), expectCode('PREFAB_ARCHIVED'))

    const unpublished = service.create(owner, draft({ name: 'Unused draft' }))
    assert.deepEqual(service.remove(owner, unpublished.id, unpublished.updatedAt), { id: unpublished.id, archived: false })
    assert.throws(() => service.get(owner, unpublished.id), expectCode('NOT_FOUND'))
  }
  finally {
    db.close()
  }
})

test('invalid binding JSON is rejected', () => {
  assert.equal(parseAgentPrefabBinding(''), null)
  assert.throws(() => parseAgentPrefabBinding('{}'), expectCode('PREFAB_BINDING_INVALID'))
})
