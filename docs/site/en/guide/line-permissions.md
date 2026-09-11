# Line-level permissions (user × line, three states)

AgentWorkShop enforces **line-level** access control on industrial data (DAQ acquisition /
DCW write control). Every user is in one of three states per line:

| State | DAQ nodes | DCW (write) nodes | Visibility |
|---|---|---|---|
| **None** (default for regular users) | hidden | hidden | the backend never returns the line's data — invisible in line operations, the DAQ center and the digital twin |
| **Read-only** | read | ✕ | line visible, live values readable; no write control, no parameter dispatch, no device binding |
| **Operate** | read | read + write | full capability: setpoint dispatch, parameter dispatch, device binding |

`admin` / `editor` are operator-management roles and are not constrained by grants (full
access to everything).

## Management entry

After an administrator signs in, the sidebar shows **Permissions** (`/permissions`,
admin-only):

1. user table: all registered users (role / status / channel count / granted-line summary),
   searchable;
2. "Manage grants" opens the user detail view:
   - basic information (email / role / status / registered at);
   - all channels created by that user;
   - the **line grant matrix**: one row per line, a three-state radio (none / read-only /
     operate), saved in batch.

## Enforcement points (data plane, not just UI hiding)

- List endpoints (`GET /api/workshop/daq`, `GET /api/workshop/dcw`,
  `GET /api/workshop/dcw/lines`) are filtered by grant — nodes and line information of an
  unauthorized line **never leave the server**;
- Write-control endpoints (setpoint dispatch / connection test / device binding / DAQ
  parameter dispatch) are validated against the line mode; over-reach returns a
  human-readable 403 — `LINE_READONLY` ("this line is read-only: read-only DAQ is visible;
  write control and operations need an administrator to grant 'operate'") or
  `LINE_FORBIDDEN` ("no permission on this line: ask an administrator to grant it in
  Permission Management");
- Agent ↔ node binding: DAQ binding requires read-only or above, DCW binding requires
  operate;
- The digital twin's entity baseline comes from the same REST endpoints, so unauthorized
  lines are equally invisible in the twin view.

## Programmatic access (SDK / plugins)

```js
// SDK REST client (admin token)
const client = createPlatformClient({ baseUrl, token })
const overview = await client.permissions.overview()   // all lines + users (with channels/grants)
await client.permissions.set({ userId, grants: [{ lineId, mode: 'operate' }] })

// plugin ctx.permissions (injected by the host)
const mode = ctx.permissions.lineMode(user, lineId)          // 'none' | 'readonly' | 'operate'
const visible = ctx.permissions.visibleLineIds(user)          // Set<lineId> | null (unrestricted)
const grants = ctx.permissions.listGrants(userId)             // [{ lineId, mode, grantedBy, grantedAt }]
await ctx.permissions.setGrants(userId, [{ lineId, mode }])   // write grants (broadcasts automatically)

// grant changes: the frontend consumes the scene event, plugins subscribe to permissions:changed
ctx.events.on('permissions:changed', ({ userId }) => { /* refresh caches */ })
```

Grant changes broadcast `permissions.changed` (a scene event, consumed by the frontend over
WS) and `permissions:changed` (a plugin event). On the plugin side the subscription must go
through `ctx.events.on(...)` — the host prefixes platform events with `event:`, so
`ctx.hooks.on('permissions:changed')` never fires.
