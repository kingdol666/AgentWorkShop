# Memory Graph

The Memory Center turns scattered memory rows into a traceable, editable, retrievable knowledge network. Each memory is an episode node; entities and fact edges form the mesh; community summaries provide topic-level views.

## Capabilities

- **Background consolidation Agent**: every 30 minutes (configurable) it consolidates channel semantic memories, validated experiences, structured claims and published ontology into entities/relations/communities. Manual "Consolidate" / "Full rebuild" is available in the Memory Center.
- **Evidence-bound**: every agent edge has at least one `memory_edge_evidence` row (memory / claim / intervention). LLM-extracted relations must cite source memory ids or are rejected.
- **Temporal**: `valid_from/valid_to/recorded_at/superseded_by`; new facts invalidate old ones instead of deleting them; `asOf` can look back.
- **Human authority**: edit, lock, merge/unmerge, reject/restore, soft delete/restore for nodes and edges. Auto consolidation never overwrites human-locked/human rows.
- **Hybrid retrieval**: entity seeds + Personalized PageRank multi-hop expansion fused into the existing FTS/vector RRF. The graph stage is skipped if it exceeds 75ms and never blocks the baseline.
- **Transparent injection**: L0.5 injects a "handbook + graph" digest (≤200 tok combined); `memory_injection_log` records graph refs, visible in "Injection trace".

## Storage

Existing SQLite only (no external graph database):

- `memory_entities` / `memory_entity_aliases` / `memory_entity_mentions`
- `memory_edges` / `memory_edge_evidence`
- `memory_communities` / `memory_community_members`
- `memory_graph_runs` / `memory_graph_state`
- `memory_graph_revisions` / `memory_merge_candidates`
- `memory_entities_fts` (FTS5) + lazy `memory_entities_vec` (sqlite-vec, optional)

The graph is a derived, rebuildable index. Memories/experiences/claims remain the source of truth. Migrations are additive and do not change the `SCHEMA_SQL` contract.

## Scope partitions (separate curation and management)

The graph is partitioned by `(channel, scope_kind, scope_key)`; Channel / Session / shared / line / product never mix:

| Partition | Sources | Used by |
|---|---|---|
| `channel` | This channel's `scope_kind='channel'` semantic/episodic-task/episodic-peer/experience (team shared rows included) | channel/private/shared/auto |
| `session` | This session's `scope_kind='session'` private memories | current session only (auto/private/session); other sessions are invisible |
| `global` | This owner's `scope_kind='global'` validated experiences (shared zone) | shared-zone UI / `memory_graph_query(scope=shared)`; runtime L2 still injects shared by owner |
| `line` | Line-level published ontology (`product_id=''`) + line claims without a product | industrial auto / explicit `scope=line` |
| `product` | Published ontology + validated/deployed claims for the given product | industrial auto / explicit `scope=product` |

- The channel graph contains only `scope_kind='channel'`; the session graph only that session; the shared graph only the same owner's global rows.
- Cross-partition edges are rejected at write time (`src/dst` must share channel + scope + owner).
- `isolated` consolidates session+channel only (no line/product/global); `disabled/readonly` do not consolidate.
- Runtime `auto` combines the current session + channel (plus line/product in industrial mode); s2's session graph is never injected into s1.

## Retrieval

1. Seeds: alias/canonical exact, entity FTS, optional entity vector, substring fallback (max 8).
2. PPR: `r=(1-α)s+αAᵀr`, α=0.85, 20 iterations/1e-6, ≤300 nodes/1200 edges; `contradicts` does not propagate.
3. Projection: entity scores project to memories through mentions/evidence; episodes map directly to `memory_id`.
4. Fusion: graph list is added at the existing `recall.collectHits` RRF point with weight 0.8; skip if >75ms.
5. Digest: at most 2 facts + 1 community title in L0.5; refs use `source='graph'`.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `AW_MEMORY_GRAPH_DISABLED` | unset | `1` disables automatic consolidation |
| `AW_MEMORY_GRAPH_INTERVAL_MS` | 1800000 | interval (min 60s) |
| `AW_MEMORY_GRAPH_INITIAL_DELAY_MS` | 60000 | first run delay |
| `AW_MEMORY_GRAPH_FULL_REBUILD_HOURS` | 24 | community full rebuild period |
| `AW_MEMORY_GRAPH_LLM_URL/KEY/MODEL/TIMEOUT_MS` | fallback to Curator env | OpenAI-compatible extraction/summary endpoint; deterministic rules when unset |
| `AW_MEMORY_GRAPH_RETRIEVAL` | on | `0` disables graph retrieval |
| `AW_MEMORY_GRAPH_SWEEP_LIMIT` | 2 | channels per sweep |

## API

Channel-scoped: `GET /api/workshop/channels/:id/memory-graph?scope=channel|session|shared|line|product&sessionId=&productId=` (subgraph/search/asOf), plus CRUD/actions for `entities`, `edges`, `merge-candidates`, `communities`, `runs`, `settings`. POST `runs` accepts the same scope fields and consolidates only that partition. Reads require a visible channel member; writes require owner/admin. All writes use strict zod + `expectedRevision` CAS + `memory_graph_revisions` snapshots + `recordOps`.

Global: `GET /api/workshop/memory/injections`, `GET /api/workshop/memory/health` (graph section), `POST /api/workshop/memory/repair` (admin).

## UI

Four Memory Center views: list / knowledge graph / injection trace / health & repair. The graph has a Channel / Session / Shared / Line / Product scope selector: sessions require a concrete session, shared reads the owner's global partition, products require a product id. Each partition is curated, queried and summarized independently. The graph uses the installed ECharts GraphChart (force layout, drag/zoom; type colors, dashed provisional edges, scope-disambiguated labels). Click a node/edge to edit in a drawer; communities, merge candidates and consolidation runs share the same page, and run rows show their partition.

## Boundaries

- No Neo4j/Kuzu; no 3D or freehand edge drawing; low-confidence similarity only creates merge candidates.
- Without an LLM endpoint, semantic relation quality is bounded by rules; structured claims/ontology still yield high-confidence facts.
- Chat-message-level citations are not built yet (Memory Center injection trace is the current surface).
- Fixed-fixture retrieval shows no single-hop regression and a multi-hop gain; real production benefit needs a two-week pilot.
