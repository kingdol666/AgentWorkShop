# Desktop chrome direction — approved

## 2026-11-24 — brand, icon and boot animation round

- Source of direction: the user asked, in one delivery, for a flashier desktop boot animation, a
  refreshed logo, artistically finished application/taskbar/tray icons, a re-review of the whole
  frontend, then commit + push + update the locally installed desktop app:
  「给我把桌面端的加载动画做的炫酷一些！然后给我把整个的前端再次查看，并把logo做好美化，确保我的桌面项目图标，
  最小化图标均是满足一个极佳的艺术设计……并投入使用，然后提交推送，并update我的本机桌面项目。」
  The instruction fixes the outcome and delegates the visual choice, so the three directions were
  rendered as real specimens, judged, and the winner taken straight to implementation.
- Three directions, all rendered before choosing (`mark-study-20261124.png`, `badge-study-20261124.png`):
  1. **Stroked gantry A** — two mint legs + cyan crossbar on a 64 grid (the previous mark). Rejected:
     at 16 px the three strokes blur, and the cyan crossbar introduces a hue the system never uses.
  2. **Dispatch rail** — the crossbar runs past the right leg into a station dot. Rejected: at 32/16 px
     the nub reads as a defect, and the asymmetry breaks centring in the sidebar.
  3. **Solid carved A on a machined plate** — one silhouette, triangular counter, 20 % plate radius,
     3 px bezel. Chosen: still an unmistakable A at 16 px, no gradient inside the letter, and the plate
     survives both dark and light taskbars.
- Letterform study: the first solid A had a small high counter (`A1`); the adopted `A2` geometry widens
  the counter and the feet (apex 104, baseline 408, 216 wide). `A3` upright was too narrow, `A4` stencil
  and `A5` rounded added nothing, `A6` lit apex and the inlaid/through signal rail all read as
  highlighter strokes — all rejected on the specimen sheet.
- Motion direction: the splash is a power-on sequence — one scan sweep, the mark draws itself in mint and
  hands over to the solid glyph, then the brand rule becomes the boot rail with four real stations. The
  assembly stage re-traces the outline once as a confirmation; nothing loops while waiting.
- Sidebar mark now renders with `currentColor` (no glow), and the web favicon, docs favicon, apple-touch
  icon, desktop badge and tray glyph all come from the same path.

Evidence: `mark-study-20261124.png`, `badge-study-20261124.png`, `splash-draw-20261124.png`,
`splash-service-20261124.png`, `splash-retrace-20261124.png`, `splash-ready-20261124.png`,
`splash-reduced-motion-20261124.png`, `desktop/build/icon.ico`, `desktop/brand/*.svg`.

## 2026-11-22 — desktop rail round

- Source of direction: the user supplied a reference screenshot of an integrated dark desktop rail and
  asked to replace the native navigation bar and the three window buttons with a product-integrated
  style, to keep the real content page identical to the web build, to deliver a prototype first, and to
  design an app icon/logo for the top-left corner.
- Direction taken: a 40 px control-room rail with the AgentWorkShop mark, live page title, local service
  status, and custom minimize/maximize/close controls; light (warm paper) and dark (deep navy + signal
  green) variants; content viewport untouched.
- Three-direction exploration was not requested for this iteration; the reference screenshot plus the
  explicit prototype→implementation order fixed the direction. Alternatives remain documented in
  `prototype.html` (light variant and interaction states). The mark from this round was superseded on
  2026-11-24.

Evidence: `prototype.html`, `prototype.png`, `desktop/chrome/titlebar.html`, `desktop/build/icon.ico`.
