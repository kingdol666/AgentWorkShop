# aw Industrial MCP Server (mcp/)

> Integration entry for external skills / MCP clients / engineer workbenches: exposes the
> platform's key REST methods as first-class MCP tools and **auto-discovers the port of the
> running local instance** — mount it and it just works, no manual port wiring.

See [docs/mcp.md](../mcp.md) (Chinese, authoritative) for the full reference. Summary:

- **Launch**: `aw mcp` (stdio) · `aw mcp --doctor` (diagnose) · `aw mcp --print-config`
- **Port discovery priority**: `AW_BASE_URL` → `AW_PORT` → `.runtime/aw.lock` lock files
  (explicit `AW_HOME` wins over implicit cwd/home discovery) → `PORT`/`NUXT_PORT` →
  `config.yml` `server.dev.port`/`server.prod.port` → defaults 3000/3001.
  Health gate: `GET /api/health` must return `data.status === 'ok'`.
- **Self-healing**: network failures invalidate the cached base and trigger one re-discovery +
  retry; 401 clears the token and lazy-relogins once. Bad credentials fail fast (no re-discovery).
- **Auth**: `AW_TOKEN`, or `AW_EMAIL` + `AW_PASSWORD` (lazy login), or the `aw_login` tool.
- **Tool surface (35)**: connection (`aw_status`, `aw_login`); lines/products/recipes
  (`aw_line_*`, `aw_product_create`, `aw_recipe_create`); DCW nodes & parameter map
  (`aw_dcw_*`, `aw_param_*`); DAQ (`aw_daq_*`); optimization channels
  (`aw_channel_*`, `aw_channel_template_instantiate`, `aw_team_provision`,
  `aw_agent_tool_bind/invoke`, `aw_twin_profile_get/patch`, `aw_task_*`, `aw_model_*`,
  `aw_optimization_judge`); plugins (`aw_plugin_list`, `aw_plugin_toggle`);
  escape hatch (`aw_request`, `/api/` prefix only).
- **Skills**: `skills/aw-node-bind`, `skills/aw-opt-channel`, `skills/aw-plugin-dev` are built
  on top of this server (`npm run test:skills` validates cross-references).
- **Tests**: `npm run test:mcp` (unit, 12 test groups) · `npm run test:mcp-live`
  (isolated-instance e2e, 34 assertions).
