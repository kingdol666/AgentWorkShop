# Real example: line-sentinel

`line-sentinel` is a small but complete plugin shipped with the repository: it watches
DAQ samples of a chosen line and exposes its own API route to set the threshold.

## What it demonstrates

- a **server hook** (`daq:sample`) doing stream analysis;
- a **plugin API route** (`POST /api/plugins/line-sentinel/threshold`) with its own state;
- **scoped logging** and the ops-log trail;
- a **manifest** with the minimal permission set.

## The code (abridged)

```js
export default {
  name: 'line-sentinel',
  setup(ctx) {
    let threshold = Number(ctx.config?.threshold ?? 100)
    ctx.routes.post('/threshold', (body) => {
      threshold = Number(body.threshold)
      ctx.log.info(`threshold set to ${threshold}`)
      return { ok: true, threshold }
    })
    ctx.hooks.on('daq:sample', (sample) => {
      if (sample.value > threshold) {
        ctx.log.warn(`over-threshold on ${sample.nodeId}: ${sample.value}`)
      }
    })
  },
}
```

## Try it

```bash
curl -X POST http://localhost:3001/api/plugins/line-sentinel/threshold \
  -H 'content-type: application/json' -d '{"threshold":100}'
```

The full source lives under `plugins/` in the repository next to `daq-vector-demo`
(a vector sink pipeline + registered template) — read both as references for your own.
