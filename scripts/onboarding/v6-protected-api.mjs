// The shared api helper returns JSON without checking the HTTP status.
export async function checkedGet({ base, token, path, fetchImpl = fetch }) {
  const response = await fetchImpl(base + path, {
    method: 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`HTTP ${response.status} for ${path}`)
  }
  const envelope = await response.json()
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.code !== 0
    || !envelope.data || typeof envelope.data !== 'object' || Array.isArray(envelope.data)) {
    throw new Error(`invalid or unsuccessful API envelope for ${path}`)
  }
  return envelope.data
}

export async function readProtectedSnapshot({ base, token, lineId, limit, fetchImpl = fetch }) {
  async function get(path, field) {
    const data = await checkedGet({ base, token, path, fetchImpl })
    if (!Array.isArray(data[field])) throw new Error(`missing ${field} array for ${path}`)
    // This API currently exposes no pagination; never accept a sign of truncation.
    if ((data.hasMore !== undefined && data.hasMore !== false) || data.nextCursor != null
      || (data.incomplete !== undefined && data.incomplete !== false)
      || (data.truncated !== undefined && data.truncated !== false)
      || (data.total !== undefined && (!Number.isSafeInteger(data.total) || data.total !== data[field].length))) {
      throw new Error(`incomplete ${field} snapshot`)
    }
    return data[field]
  }

  try {
    const lines = await get('/api/workshop/dcw/lines', 'lines')
    const anchors = await get(`/api/workshop/dcw/journal?lineId=${encodeURIComponent(lineId)}&limit=${limit}`, 'anchors')
    return { lines, anchors }
  }
  catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
