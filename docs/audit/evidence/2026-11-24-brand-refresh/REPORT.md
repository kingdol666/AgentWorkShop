# Frontend review — 2026-11-24 (brand, icons, boot sequence)

Scope: the shared web UI served by the Nitro build of PR #289 and the two Electron chrome documents
(`titlebar.html`, `splash.html`). Same page set as the product: 27 routes from `scripts/ui/lib.mjs`,
both themes, 1440 × 900, real Chrome, isolated `AW_HOME` and a freshly registered admin.
Not in scope: permissions model, API contracts, hardware/line behaviour (unchanged by this round).

## Method

```
AW_BASE=http://127.0.0.1:3113 AW_TOKEN=<isolated admin> \
  node scripts/ui/audit-layout.mjs --vp 1440x900 --routes all --theme both --wait 4000
AW_BASE=http://127.0.0.1:3113 AW_TOKEN=<isolated admin> \
  node scripts/ui/shots.mjs --theme both --vp 1440x900 --routes dashboard,workshop
```

The audit measures, per load: horizontal overflow (document + element), clipped text
(`overflow:hidden` with content exceeding the box), visible-rect overlap, touch targets (<32/<40 px),
text size floor (body <13 px, label <11 px), WCAG contrast on the rendered colours, and fixed/sticky
elements outside the viewport.

## Result

| Metric | Result |
| --- | --- |
| Page loads | 54 (27 routes × 2 themes) |
| Page errors | 0 |
| Horizontal overflow | 0 |
| Loads with any audit item | 54 (all items below) |

Raw rows: run output kept outside the repo (`audit/audit.json`, `audit-fixed/audit.json`); counts are
reproduced below because the raw file embeds per-element geometry.

### Items found and fixed

| Item | Where | Fix |
| --- | --- | --- |
| Header trail showed English slugs — “Tools”, “Data”, “Studio”, “Board”, “Pipeline”, “Optimizer”, “Ontology” | `/tools`, `/data`, `/studio*`, `/optimizer`, `/ontology` (52 loads) | Seven entries added to `useRouteMeta.staticMap` with the existing menu keys; verified `/tools` → 「工具管理」 |
| Sidebar tagline `DIGITAL TWIN` at 10 px (label floor is 11 px) | every page (52 × font-too-small) | `.logo-sub` back to 11 px; re-audit shows the item gone |
| Appearance switch flipped its title between 「亮色 / 暗色」 while the switch tracks dark mode, so light mode read as “亮色 — off” | `/settings` | Row title fixed to the setting's name; verified title 「暗色」 |
| Login dialog posted empty credentials and showed a raw `400 Bad Request` toast | guest dashboard login modal | Client-side guards mirroring the `/workshop` gate; verified **0 requests** and 「请填写邮箱」 |

### Items reviewed and accepted (not defects)

| Item | Count | Why it is not a defect |
| --- | --- | --- |
| `overlap` between `div.menu-group` and `div.sider-footer` | 52 | The nav is a scroll container (`scrollHeight 920 / clientHeight 790`); its content rect extends below the scrollport and the audit does not account for ancestor clipping. Scrolled to the end, the last item (系统设置) ends at y=824, above the footer at y=848 — every item is reachable. |
| `text-clipped` on `span.sr-only` | 2 | Screen-reader-only text (1 px box) is clipped by design. |
| `font-too-small` on the dashboard LIVE chip (`span.sb-lines`, 10 px) | 2 | Pre-existing instrument micro-label inside the status band; kept deliberately (semantic status readout, 4.6:1 contrast). Recorded here rather than changed in a brand round. |

## Screen evidence

| File | Shows |
| --- | --- |
| `dashboard-dark.png` | new mark in the dark sidebar, title rail, 11 px tagline |
| `dashboard-light.png` | same shell on light paper |
| `workshop-light.png` | workspace overview with the new brand block |
| `tools-trail-fixed.png` | header trail reads 「工具管理」 instead of “Tools” |
| `settings-appearance-fixed.png` | appearance row titled 「暗色」 with the switch matching |
| `login-empty-guard.png` | empty submit blocked with 「请填写邮箱」, no request |

## Limits

- Layout/typography only; no security conclusion. The Mimosa scan for this branch has no complete
  sealed result, so no claim of a security pass is made.
- Touch-target and contrast checks ran at 1440 × 900 (desktop). The narrow-viewport matrix
  (`scripts/ui/verify-responsive.mjs`) was not repeated this round; the brand change is a 32 px box and
  a text size, with no layout change at other breakpoints.
