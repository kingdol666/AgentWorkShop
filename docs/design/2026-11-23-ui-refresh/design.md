---
version: anydesign-1
name: AgentWorkShop Quiet Instrument UI
source: D:/tmp/aw-electron-desktop/app + desktop/chrome/splash.html
captured_at: 2026-11-23
description: |
  AgentWorkShop is an industrial agent operations surface: calm enough for long
  conversations, exact enough for plant data, and explicit about risk. The refresh
  keeps the existing instrument-panel identity while making navigation, dense data,
  and desktop boot states easier to read and operate.
colors:
  primary: "#35E0A0"
  canvas-dark: "#070B13"
  canvas-light: "#F2F5F9"
  surface-dark: "#0D1420"
  surface-light: "#FFFFFF"
  text-dark: "#E8EEF8"
  text-light: "#0E1520"
  text-muted-dark: "#B8C7D8"
  text-muted-light: "#475569"
  border-dark: "#2C4568"
  border-light: "#D8E1EA"
  focus: "#2563EB"
  success: "#367048"
  info: "#3F6094"
  warning: "#8F5C07"
  danger: "#A83F34"
typography:
  display: { fontFamily: "Geist Variable, Geist, sans-serif", fontSize: 30px, fontWeight: 600, letterSpacing: -0.015em }
  body: { fontFamily: "Geist Variable, Geist, sans-serif", fontSize: 14px, fontWeight: 400, lineHeight: 1.5 }
  data: { fontFamily: "Geist Mono Variable, Geist Mono, monospace", fontSize: 13px, fontWeight: 500, lineHeight: 1.4 }
spacing:
  base: 4px
  scale: [4, 8, 12, 16, 20, 24, 32, 48]
rounded:
  sm: 6px
  control: 8px
  panel: 12px
  shell: 14px
  pill: 9999px
shadows:
  float: "0 8px 28px rgb(12 10 9 / 12%)"
components:
  page-header: { kicker: "mono 11px", title: "30px / 600", description: "14px muted", action: "right aligned" }
  state-block: { surface: "surface", border: "hairline", status: "semantic tone", actions: "explicit" }
  data-panel: { background: "surface", rounded: "{rounded.panel}", border: "{colors.border-light}" }
  chat-composer: { background: "surface-light", rounded: "{rounded.panel}", focus: "{colors.focus}" }
  boot-splash: { background: "{colors.canvas-dark}", signal: "{colors.primary}", progress: "transform + opacity" }
---

# Design Analysis: AgentWorkShop Quiet Instrument UI

> Analysis generated with the anydesign skill. Date: 2026-11-23. Emphasis: design system + reconstruction.

## Source

Source is the existing AgentWorkShop web application and Electron chrome in `D:/tmp/aw-electron-desktop`. The token layer was read from `app/assets/css/main.css`, the Ant Design authority from `app/app.vue`, route shells from `app/layouts/default.vue` and `app/layouts/console.vue`, and boot visuals from `desktop/chrome/splash.html`. Existing browser evidence uses Puppeteer through `scripts/ui/lib.mjs`; it covers the current 22-route static matrix and separate dynamic-route scripts. No external visual reference was used.

## TL;DR

AgentWorkShop already has a strong industrial instrument direction: cold steel surfaces, a single signal-green action color, mono data, and hairline boundaries. The refresh should not flatten the product into generic cards. Make each functional family legible through composition: reading-first chat, alert-first operations, and evidence-first projects. The highest-leverage work is shared shell focus behavior, deterministic theme/cascade ownership, and honest boot motion rather than decorative effects.

## 1. Visual identity

### 1.1 Surface description

- **Personality:** calibrated, quiet, operational, exact ✅ — the current token system uses one signal color, semantic status tones, and mono data.
- **Mood:** a control room at low light ⚠️ — dark navy surfaces and thin rules dominate the desktop shell; light mode is a cold paper counterpart.
- **Stylistic references:** industrial instrument panel with a restrained chat workspace ✅ — `main.css` calls the system “Industrial Instrument” and console pages use separate chat tokens.
- **Information density:** high but partitioned ✅ — dashboard, DAQ/DCW, and monitor pages are dense; the console isolates navigation, conversation, and context panes.
- **Implicit positioning:** a governed engineering workbench, not a consumer chat app ⚠️ — actions and approvals retain explicit status and evidence surfaces.

### 1.2 Brand voice / Atmosphere

The interface treats the operator as someone making consequential decisions with incomplete time. It therefore uses quiet surfaces, crisp data alignment, and one unmistakable action color instead of decoration competing with telemetry. Conversation can feel spacious because it is a work surface, while operations stay dense because a line state needs comparison. Every page should answer “what is happening, what needs attention, and what can safely happen next?” before exposing secondary detail.

### 1.3 The “ONE brand thing”

- **Thing:** a signal-green rule and action (`#35E0A0`) ✅ — it is the only global primary action and echoes the boot splash.
- **Why:** it reads as an instrument signal, not a marketing gradient ✅ — green is reserved for action/healthy state.
- **Restraint:** surfaces remain steel/navy or cold paper; semantic colors are never decorative ✅.
- **Where:** primary controls, active progress, boot stages, and healthy indicators; never as a blanket card tint ✅.

## 2. Design System (tokens)

### 2.1 Colors

Dark canvas is `{colors.canvas-dark}` (#070B13) with `{colors.surface-dark}` (#0D1420) panels and `{colors.text-dark}` (#E8EEF8) ink. Light canvas is `{colors.canvas-light}` (#F2F5F9) with `{colors.surface-light}` (#FFFFFF) panels and `{colors.text-light}` (#0E1520) ink ✅. `{colors.primary}` (#35E0A0) is the action signal; `{colors.focus}` (#2563EB) is reserved for keyboard focus. Success, info, warning, and danger use the existing semantic tones; status text must include a label or icon as well as color.

### 2.2 Typography

Geist is the body/display family and Geist Mono is the data family ✅. Use 30px/600 for a page title, 14px body copy, 11px minimum labels, and tabular mono for IDs, times, measurements, and counts. Use `text-wrap: balance` or `text-wrap: pretty` on headings and descriptions. EB Garamond remains a rare brand accent in the shell footer, not a page-wide voice.

### 2.3 Spacing

The observed base is 4px with 8/12/16/20/24/32px groupings ✅. Default page content keeps at least 20px horizontal breathing room on desktop and reduces to 12–16px in compact tiers. Dense tables scroll inside their own panel; the document itself must not acquire horizontal overflow.

### 2.4 Radii

The system uses 6px small elements, 8px controls, 12px panels, 14px shells, and pill radius only for statuses/counts ✅. Do not turn tables, telemetry grids, or log rows into pills.

### 2.5 Elevation system

Depth comes primarily from surface steps and hairline rules ✅. `{shadows.float}` (0 8px 28px rgb(12 10 9 / 12%)) is reserved for drawers, command panels, and other floating surfaces. Avoid large shadows on every card.

### 2.6 Borders

Use a 1px border for panel ownership and a lighter divider for internal grouping. The boot splash uses a green signal segment followed by a quiet hairline, matching the title rail. Focus rings use the dedicated blue focus token and must remain visible on both themes.

### 2.7 Accessibility quick-check

The implementation must keep visible `:focus-visible`, semantic buttons/links, named icon buttons, keyboard-operable tabs/switches, inline error text, and reduced-motion variants. Test long Chinese and English labels at 320px, 390px, 768px, and the Electron minimum window. A drawer must move focus in, close on Escape, restore focus to its trigger, and preserve the prior body overflow value.

## 3. Components Inventory

### 3.1 Generic components

- `AppSidebar` — navigation groups with desktop, rail, and drawer modes.
- `AppHeader` — route context, connection state, HITL, tools, user identity.
- `AwStateBlock` — loading, empty, and error states with a common action surface.
- `AwChart` / `useChartTheme` — chart container and token bridge.
- page header / filter / table patterns — shared across operations, data, and administration.

#### page-header

The page header uses a mono kicker, one balanced heading, a short description, and an action cluster aligned to the same top rhythm. At drawer widths the cluster wraps below the description rather than compressing the heading.

#### state-block

Loading, empty, error, and offline states share a bounded panel, one explanatory sentence, and a next action. Error text remains selectable and actionable; status color is accompanied by a label.

#### data-panel

A data panel is a solid surface with a 1px ownership border and a 12px radius. Tables and log streams scroll inside the panel, never by pushing the document wider.

### 3.2 Signature components

#### chat-composer

The console composer is a reading-first input surface: the message column gets the widest measure, context panes open on demand, and the composer remains visible without covering the last message. Focus uses the shared blue ring.

#### boot-splash

`splash.html` shows truthful prepare/data/service/workshop stages and a failure recovery panel. Stage changes use `transform`/`opacity`; the progress value is the real stage value, not a timed illusion.

- **Console shell:** `Rail`, `Topbar`, `LeftPane`, `CenterPane`, `RightPane`, and `Dock` create a reading-first multi-session workspace.
- **Signal dashboard:** the home page combines status bands, trend, pipeline, alarms, and line cards into an operational overview.
- **Boot instrument:** the splash is offline-safe and keeps retry/log/quit reachable at compact heights.

## 4. Layout & Composition

### 4.1 Grid & containers

The default shell is a two-part flex layout: navigation plus a min-width-zero main column. Standard pages use a page header followed by task panels. Console pages occupy the entire viewport and place navigation on the left, conversation in the center, and context on the right. Town is intentionally full-screen and should not inherit the standard shell.

### 4.2 Composition patterns

- **Operations:** status/alert band first, then trend and control surfaces; dangerous writes are visually separated and require existing governance.
- **Workspace:** channel/session selection first, message reading second, composer fixed at the bottom, context drawers on demand.
- **Projects:** project status and progress first, then work items/deliverables/approval evidence; filters remain adjacent to the list.
- **Administration:** grouped settings with explicit labels, helper copy, and a visible save/error state.

### 4.3 Responsive behavior

`useResponsive` is the behavior source: desktop at 1024px+, compact rail at 900–1023px, drawer/tablet at 640–899px, and mobile below 640px ✅. Desktop navigation remains stable; mobile changes information architecture to a drawer. Console panes should become on-demand drawers rather than narrow three-column squeezes. Electron currently enforces an 800px minimum window, so 320–640px coverage belongs to the web browser audit.

### 4.4 Image behavior

The main product uses SVG icons, charts, and canvases rather than editorial imagery. SVGs are decorative unless they convey a status; meaningful canvas/3D views need adjacent text status. Any future raster image should reserve width/height and lazy-load below the fold.

## 5. Reconstruction Notes

Keep the current token authority in `app/app.vue` and `main.css`, but make ownership explicit: root tokens first, Ant Design overrides next, page-family rules after that, and scoped component rules only for local layout. Reuse `useResponsive`, `AwStateBlock`, `AwChart`, and the existing `data-testid` anchors. Prefer CSS transitions for short feedback and the existing token curves; do not introduce a motion package for shell polish. Desktop boot motion should communicate a real stage transition and use transform/opacity; the progress model must remain a real stage value from `chrome/contract.mjs`.

## 6. Do's and Don'ts

### Do

- Do make the next safe action obvious.
- Do keep status labels adjacent to status colors.
- Do preserve deep links, testids, and existing API behavior.
- Do use `min-width: 0`, line clamping, and container scrolling for long names and logs.
- Do validate both `aw-theme` SSR and hydrated theme at first paint.
- Do test focus and keyboard paths, not only screenshots.

### Don't

- Don’t flatten telemetry, chat, projects, and administration into one card template.
- Don’t hide overflow on the document to conceal a broken layout.
- Don’t use color alone for alarm, approval, or connection state.
- Don’t animate keyboard-frequency actions or use `transition: all`.
- Don’t claim Electron mobile breakpoints when the shell minimum is 800px.
- Don’t use shared user data or credentials as a visual fixture.

## 7. Open Questions

- Should desktop chrome follow the web locale immediately, or should it remain a compact Chinese-first shell until a locale IPC contract is designed?
- Should the Electron minimum window be lowered, or should 800px remain a deliberate desktop-only constraint?
- The visual gate currently needs a reproducible Electron debug-port wrapper; historical screenshots alone are not a new acceptance run.

## 8. Companion files

- `docs/design/2026-11-23-ui-refresh/route-coverage.md` — 31-route coverage ledger.
- Existing visual helpers: `scripts/ui/lib.mjs`, `scripts/ui/shots.mjs`, `scripts/ui/audit-layout.mjs`, `scripts/ui/verify-responsive.mjs`, `scripts/ui/shot-console.mjs`.
- Existing baseline: `docs/ui/acceptance-2026-10-18.md`.
