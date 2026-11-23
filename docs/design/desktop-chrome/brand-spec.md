# AgentWorkShop desktop brand spec

Source of truth: `desktop/brand/*.svg` (mark masters) and `scripts/desktop-brand.mjs` (rasteriser).
Colour roles follow `app/assets/css/main.css` (Industrial Instrument system); the mark adds no new hue.

## Mark

The A of the workshop gantry. One silhouette: flat apex, 216-wide baseline, triangular counter.

```
outer     M232 104 H280 L364 408 H322 L294 320 H218 L190 408 H148 Z
counter   M256 176 L222 272 H290 Z      (fill-rule="evenodd")
```

Design rules that are not negotiable:

- The path above is the only master. `desktop/brand/mark.svg`, `AwLogo.vue`, `splash.html`, `titlebar.html`,
  `badge.svg` and `public/favicon.svg` carry the exact same `d`. Change it everywhere or nowhere.
- No gradient, no glow, no second hue inside the letterform. At 16 px a two-stop gradient turns to mud
  and a coloured crossbar reads as a highlighter stroke — both were tested and rejected (see
  `mark-study-20261124.png`, `badge-study-20261124.png`).
- Colour is `currentColor`: ink `#0e1520` on light paper, paper ink `#e9eff8` on dark chrome.
  Signal green belongs to status and motion, not to the structural mark.

## Badge (application icon)

512 canvas · plate radius 104 (20 %) · 3 px bezel at 11 % white · glyph 59 % of the canvas height.

| Part | Value |
| --- | --- |
| Plate gradient | `#13202f` → `#0c1521` (55 %) → `#070d15` |
| Bezel | `#e9eff8` at 11 %, 3 px, inset 3 px |
| Glyph | `#edf2f8` (paper white) |

The gradient is a 2.6 % material lift, not lighting. The bezel is the only edge treatment; there is no
outer glow, drop shadow or coloured ring.

## Icon ladder

| File | Size | Use |
| --- | --- | --- |
| `desktop/build/icon.ico` | 16, 20, 24, 32, 40, 48, 64 (BMP) + 128, 256 (PNG) | exe, installer, taskbar, Alt-Tab, Explorer |
| `desktop/build/icon.png` | 512 | BrowserWindow / notification icon |
| `public/favicon.svg` | vector | browser tab, docs site |
| `public/icon-180.png` | 180 | `apple-touch-icon` |
| `public/icon-512.png` | 512 | PWA/large surfaces |
| `desktop/build/tray-dark.png` | 32 | tray on a dark taskbar — signal green `#3fe4ab` |
| `desktop/build/tray-light.png` | 32 | tray on a light taskbar — deep jade `#0e7a56` (4.8:1 on `#f3f3f3`) |

The tray glyph is the bare mark, scaled to 313 × 441 in the 512 box so it fills the notification slot
(16–24 px) instead of shrinking inside plate padding. `desktop/main.mjs` swaps the two files on
`nativeTheme` changes.

Rebuild everything after editing a master:

```bash
pnpm brand:desktop        # = node scripts/desktop-brand.mjs (needs local Chrome, AW_CHROME to override)
```

## Wordmark

`Agent` at weight 500 in secondary ink, `WorkShop` at weight 650 in primary ink — 12.5 px in the title
rail, 12.5 px mono caps in the sidebar (`AGENTWORKSHOP`, 0.075 em tracking, `DIGITAL TWIN` at 10 px,
0.16 em). Never set the wordmark in all caps and mixed weights inside the rail.

## Splash motion

| Moment | Duration | Easing |
| --- | --- | --- |
| Boot scan (one vertical light sweep) | 1100 ms, once | `cubic-bezier(.22,1,.36,1)` |
| Mark outline draw | 760 ms, once | `cubic-bezier(.16,1,.3,1)` |
| Fill hand-over | 200 ms after draw | ease-out |
| Stage transition: rail fill | 240 ms | `cubic-bezier(.22,1,.36,1)` |
| Station arrival: one ring, 520 ms; signal head 320 ms | once per stage | ease-out |
| Assembly re-trace | 420 ms, once | `cubic-bezier(.16,1,.3,1)` |
| Splash leave | 240 ms opacity | ease-out |

Nothing loops while waiting. Progress is the backend's real boot progress; the splash never invents a
percentage. `prefers-reduced-motion: reduce` keeps every state and drops all of the above to static.

## Typography, shape, colour

Rail 40 px; controls 44 × 28 with 7 px radius; status pill 999 px; hover 120 ms ease-out. Dark chrome
`#070c14`/`#0b1322` with `#1d2a3d` hairlines; light chrome `#ffffff`/`#f6f5f2` with `#e4e1dc`.
Signal green `#3fe4ab` (dark) / `#1f8f66` (light) marks live state only. Reduced motion disables the
connecting-dot pulse and all transitions.
