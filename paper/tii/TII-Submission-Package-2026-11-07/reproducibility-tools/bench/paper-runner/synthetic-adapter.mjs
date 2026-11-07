import { createHash } from 'node:crypto'

/** In-memory test double. Nothing here connects to a platform or PLC. */
export class MockAdapter {
  kind = 'synthetic-fixture'

  async reset({ scene, seed }) {
    this.scene = scene
    this.seed = seed
    this.value = 10 + seed % 3
    this.control = 0
    this.time = 0
    this.writeEvents = []
    const state = { scene, seed, value: this.value, control: this.control }
    return { ...state, fingerprint: createHash('sha256').update(JSON.stringify(state)).digest('hex') }
  }

  async sample(offsetMs) {
    if (!Number.isSafeInteger(offsetMs) || offsetMs < this.time) throw new Error('clock moved backwards')
    this.value += this.control * ((offsetMs - this.time) / 1000)
    this.time = offsetMs
    return { offsetMs, value: this.value }
  }

  async act(offsetMs, action) {
    if (offsetMs !== this.time || action.delta !== 1) throw new Error('invalid synthetic action')
    this.control += action.delta
    const event = { offsetMs, status: 'accepted', value: this.control, source: 'synthetic-fixture' }
    this.writeEvents.push(event)
    return event
  }

  async close() { return { value: this.value, control: this.control, writeEvents: this.writeEvents } }
}
