# Line-level permissions (user × line, three states)

AgentWorkShop enforces **line-level** access control on industrial data. Every user is in
one of three states per line:

| State | DAQ nodes | DCW (write) nodes | Visibility |
|---|---|---|---|
| **None** (default for regular users) | hidden | hidden | the backend never returns the line's data — invisible in line ops, DAQ center and the twin |
| **Read-only** | read | ✕ | line visible, live values readable; no write control, no dispatch, no device binding |
| **Operate** | read | read + write | full capability: setpoints, dispatch, device binding |

`admin` / `editor` are operator roles, unconstrained by grants.

## Management entry

Admins get a **Permissions** page in the sidebar (`/permissions`, admin-only):

1. user table: all registered users (role / status / channel count / grant summary), searchable;
2. "manage grants" opens the user drawer:
   - profile (email / role / status / registered at);
   - all channels created by the user;
   - **line grant matrix**: one row per line, three-state radio (none / read-only /
     operate), saved in batch.

## Enforcement points (data plane, not just UI hiding)

- REST endpoints check the caller's grant per line — reads need read-only+, writes need
  operate;
- node binding to a line's DAQ/DCW nodes requires the matching grant;
- scene/WS fan-out filters telemetry per peer, so hidden lines never reach the client;
- plugin SDK contexts carry the same permission view (`ctx.permissions`).
