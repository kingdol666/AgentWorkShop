# Browser-side SDK

For browser enhancements, `createClientContext` gives your script the same platform
awareness as server plugins: current user, tokens, base URL and typed helpers — without
touching global state.

## Usage

```js
import { createClientContext } from 'agentworkshop/sdk/client'

const ctx = createClientContext()
const me = await ctx.user.me()          // uses the session cookie
ctx.bus.on('daq.reading', (frame) => { /* live frames from the platform WS hub */ })
```

## Notes

- authentication reuses the platform session cookie — no token handling in the browser;
- live frames arrive over the same WS hub the dashboards consume (`daq.reading`,
  `dcw.node.changed`, `ops.log`, …), filtered by the caller's line permissions;
- ship your script as a **plugin browser enhancement** (declare it in the plugin
  manifest) and the host injects it into the page — no build step required.
