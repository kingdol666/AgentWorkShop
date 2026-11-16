// Pure V6 decision logic. Snapshots contain checked lines and journal reads, or an error.
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]))
  }
  return value
}

export function evaluateProtectedFixture({ before, after, lineId, limit }) {
  const fail = reason => ({ status: 'FAIL', reason })
  if (typeof lineId !== 'string' || !lineId || !Number.isInteger(limit) || limit <= 0) return fail('invalid evaluator configuration')

  function validate(snapshot, phase) {
    if (!snapshot || snapshot.error) return { error: `${phase} read failed: ${snapshot?.error ?? 'missing snapshot'}` }
    if (!Array.isArray(snapshot.lines) || !Array.isArray(snapshot.anchors)) return { error: `${phase} snapshot is incomplete` }
    if (snapshot.lines.some(line => !line || typeof line.id !== 'string' || !line.id)) return { error: `${phase} line list is malformed` }
    if (snapshot.anchors.length >= limit || snapshot.incomplete) return { error: `${phase} journal snapshot is capped or incomplete` }
    const lines = snapshot.lines.filter(line => line.id === lineId)
    if (lines.length > 1) return { error: `${phase} line list has duplicate protected IDs` }
    const anchors = new Map()
    for (const anchor of snapshot.anchors) {
      if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)
        || typeof anchor.id !== 'string' || !anchor.id || anchor.lineId !== lineId
        || typeof anchor.nodeId !== 'string' || !anchor.nodeId
        || typeof anchor.at !== 'string' || !anchor.at
        || typeof anchor.source !== 'string' || !anchor.source || typeof anchor.actor !== 'string' || !anchor.actor
        || !Number.isFinite(anchor.newValue) || (anchor.prevValue !== null && !Number.isFinite(anchor.prevValue))) {
        return { error: `${phase} journal contains malformed or unrelated anchors` }
      }
      if (anchors.has(anchor.id)) return { error: `${phase} journal has duplicate anchor IDs` }
      anchors.set(anchor.id, JSON.stringify(canonical(anchor)))
    }
    if (!lines.length && anchors.size) return { error: `${phase} journal contains anchors for an absent line` }
    return { exists: lines.length === 1, anchors }
  }

  const pre = validate(before, 'before')
  if (pre.error) return fail(pre.error)
  const post = validate(after, 'after')
  if (post.error) return fail(post.error)
  if (!pre.exists && !post.exists) return { status: 'SKIP', reason: 'protected fixture absent before and after' }
  if (!pre.exists) return fail('protected line created during verification')
  if (!pre.anchors.size) return fail('protected journal baseline is empty')
  if (!post.exists) return fail('protected line deleted during verification')
  for (const [id, content] of pre.anchors) {
    if (!post.anchors.has(id)) return fail(`baseline anchor removed: ${id}`)
    if (post.anchors.get(id) !== content) return fail(`baseline anchor changed: ${id}`)
  }
  for (const id of post.anchors.keys()) {
    if (!pre.anchors.has(id)) return fail(`new protected anchor: ${id}`)
  }
  return { status: 'PASS', reason: `protected journal unchanged (${pre.anchors.size} anchors)` }
}
