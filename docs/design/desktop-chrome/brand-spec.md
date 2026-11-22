# AgentWorkShop desktop brand spec

Source of truth: `app/assets/css/main.css` (Industrial Instrument system) and the existing agent console.

## Palette

| Role | Dark | Light |
| --- | --- | --- |
| Rail top / bottom | `#0b1322` / `#070c14` | `#ffffff` / `#f6f5f2` |
| Rail hairline | `#1d2a3d` | `#e4e1dc` |
| Primary ink | `#e9eff8` | `#0c0a09` |
| Secondary ink | `#b6c3d5` | `#57534e` |
| Faint ink | `#93a3b8` | `#6b665d` |
| Signal accent | `#3fe4ab` | `#1f8f66` |
| Data accent | `#41c8f4` | `#2bb9e8` |
| Close hover | `#d93a3f` | `#cf3036` |

The rail reuses the app's `--accent` semantics: signal green for live/primary, data cyan for information, amber for pending, red only for destructive/close. No decorative gradients beyond the 4–8% accent glow used to separate the rail from the canvas.

## Mark

`desktop/brand/icon.svg` — a bold "A" whose two legs represent agents and whose cyan crossbar is the channel bus. The badge is a 512px rounded square (radius 120) with a deep navy gradient, a 20% mint inner keyline, and transparent corners. The same geometry is inlined at 24px in `desktop/chrome/titlebar.html`.

## Type

Rail wordmark: 12.5px, `Agent` at weight 500 in secondary ink, `WorkShop` at weight 650 in primary ink; page label 11.5px; status 10.5px; all letter-spacing 0.015–0.02em. Body font stack starts with the app's Geist, then Segoe UI Variable / Microsoft YaHei UI.

## Shape and motion

Rail 40px; controls 44×28 with 7px radius; status pill 999px; hover 120ms ease-out; close hover becomes the only solid danger fill. Reduced-motion disables the connecting-dot pulse and transitions.
