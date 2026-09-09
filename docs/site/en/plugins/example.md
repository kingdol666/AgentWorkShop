# Real example: line-sentinel

A real, complete plugin shipped with the repository — the source is the documentation:
`sdk/examples/line-sentinel/` (also installed user-level at
`~/.AgentWorkShop/plugins/line-sentinel/`).

## What it demonstrates

- a **server hook** (`daq:sample`) doing stream analysis with per-node alarm counting;
- **platform service consumption** (`ctx.api.lines.list()` loopback REST, self-healing
  during startup);
- **plugin API routes**: `GET /api/plugins/line-sentinel/report` and
  `POST /threshold` (pre-read body on `event.awBody`);
- **line lifecycle tracking** (`line:start` / `line:stop`), **config change awareness**
  (`ctx.config.onChange`), a **5 s heartbeat timer** proving the REST loopback channel
  against the unauthenticated manifest ping, and **cleanup registration** (`ctx.onDispose`);
- a **browser badge** (`client.mjs`) showing live sample/alarm counts.

## The code (abridged from `sdk/examples/line-sentinel/index.mjs`)

```js
export default {
  name: 'line-sentinel',
  version: '1.0.0',
  description: 'Line sentinel: DAQ over-threshold alarms + heartbeat + line lifecycle',
  client: './client.mjs',

  async setup(ctx) {
    ctx.logger.info(`loaded (scope=${ctx.scope}, sdk=${ctx.sdkVersion})`)

    // Platform consumption: read the line list over loopback REST (self-heals if the
    // server is still starting)
    try {
      const lines = await ctx.api.lines.list()
      ctx.kv.set('linesTotal', Array.isArray(lines) ? lines.length : 0)
    }
    catch (err) { ctx.logger.warn('line list not ready yet:', err?.message) }

    // Config changes (aw config set / Settings UI → runtime-settings.json)
    ctx.config.onChange(() => {
      ctx.logger.info('config changed', ctx.config.get('theme.primaryColor'))
    })

    // Line lifecycle
    ctx.hooks.on('line:start', (p) => { ctx.kv.set('running', true); ctx.kv.bump('runningCount') })
    ctx.hooks.on('line:stop', () => ctx.kv.set('running', false))

    // Core: over-threshold alarms (threshold stored in plugin KV, default 180)
    ctx.hooks.on('daq:sample', (s) => {
      ctx.kv.bump('samples')
      const threshold = Number(ctx.kv.get('threshold')) || 180
      if (typeof s?.value === 'number' && s.value > threshold) {
        const key = `alarm:${s.nodeId}`
        const prev = ctx.kv.get(key) ?? { count: 0 }
        ctx.kv.set(key, { count: (prev.count ?? 0) + 1, value: s.value, at: s.at })
      }
    })

    // Heartbeat (auto-collected on server close); manifest ping proves the REST loopback
    ctx.timer.setInterval(() => {
      ctx.kv.set('heartbeat', new Date().toISOString())
      ctx.api.plugins.manifest()
        .then(() => ctx.kv.set('apiOk', true))
        .catch(() => ctx.kv.set('apiOk', false))
    }, 5000)

    ctx.onDispose(() => ctx.logger.info('sentinel cleanup: alarm state already flushed'))

    // Plugin API
    ctx.route('GET', '/report', () => ({ /* aggregated report */ }))
    ctx.route('POST', '/threshold', (event) => {
      const v = Number(event.awBody?.threshold) || 180   // host pre-reads the body
      ctx.kv.set('threshold', v)
      return { ok: true, threshold: v }
    })
  },
}
```

## Try it

```bash
curl -X POST http://localhost:3001/api/plugins/line-sentinel/threshold \
  -H 'content-type: application/json' -d '{"threshold":100}'
curl http://localhost:3001/api/plugins/line-sentinel/report
```

The repository also ships `sdk/examples/ops-notifier/` and `sdk/examples/sample-insight/`,
plus `daq-vector-demo` and `omp-sensor-tools` under the project's `.AgentWorkShop/plugins/`
(vector sink pipelines and hot-injected agent tools) — read them all as references.
