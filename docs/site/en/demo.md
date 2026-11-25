---
title: AgentWorkShop Product Demo
description: The AgentWorkShop 0.20.1 90-second system film and the 3-minute core demo, with a real desktop task, scene index and evidence boundaries.
---

# AgentWorkShop Product Demo

## 2026-11 cut: the 90-second system film (real 0.20.1 desktop task)

<video controls preload="metadata" :poster="'/AgentWorkShop/demo/agentworkshop-0.20.1-promo-poster.jpg'" style="display:block;width:100%;aspect-ratio:16/9;background:#000">
  <source :src="'/AgentWorkShop/demo/agentworkshop-0.20.1-promo.mp4'" type="video/mp4">
</video>

**Standalone links**: [direct MP4](/AgentWorkShop/demo/agentworkshop-0.20.1-promo.mp4) ·
[poster](/AgentWorkShop/demo/agentworkshop-0.20.1-promo-poster.jpg) ·
[README entry](https://github.com/kingdol666/AgentWorkShop#watch-the-90-second-film)

**Specs**: 87.70 s · 1920×1080 @30fps · H.264 High@4.1 + AAC 48k · ~15.7 MB (faststart) ·
Chinese on-screen captions · no voice-over (caption-driven) · 19 shots, 7 dissolves/
fade-through-black/wipes + 12 hard cuts.

**Scene index**:

| Time | Chapter | Content |
|---|---|---|
| 00:00 | Cold open | AI teams, not just chat; read the line · write setpoints · hand over evidence |
| 00:07 | One codebase | Real splash; `aw desktop` / `aw web`, one `~/.AgentWorkShop`, a single-writer lock |
| 00:13 | Update governance | 0.20.1 update centre: explicit consent, three routes, SHA-256 (not a publisher signature) |
| 00:20 | Agent team | A Channel is the workbench; 14 execution engines |
| 00:29 | Digital twin | The line lives in the same Channel; task list, status timeline, artifacts |
| 00:46 | Industrial loop | Sensor → evidence chain; a refused write is evidence too |
| 00:57 | Statistics | 67 minutes / 270 15-second buckets / 185.048 °C / +0.048 °C deviation |
| 01:06 | Governance & version | 0.20.1, regression counts, failures made readable |
| 01:19 | Close | Brand, GitHub / docs / npm entry points, compliance footnotes |

**Evidence boundaries**: the footage comes from a real 0.20.1 desktop instance (isolated home,
demo line `ln-cca0c356`, `simulated=true`). Task `0c3e927d` used real `daq_query` / `daq_export`
tool calls and produced a 5,153-byte `review-report.md`; the lead task `6ba58e33` stalled in tool-
catalogue traversal and was cancelled — it stays on the task board but is not shown in close-up.
Only 2026-11-25 13:54:11–15:01:23 (about 67 minutes) has valid data, and the film never calls it a
7-day continuous trend. **Simulator evidence is not physical HIL or production approval**;
Mimosa is `partial / inconclusive` (no security endorsement); the installer is unsigned and its
SHA-256 is not a publisher signature.

## 2026-10 cut: the 3-minute core demo (English UI, EN/ZH captions)

<video controls preload="metadata" :poster="'/AgentWorkShop/demo/agentworkshop-core-demo-poster.png'" style="display:block;width:100%;aspect-ratio:16/9;background:#000">
  <source :src="'/AgentWorkShop/demo/agentworkshop-core-demo.mp4'" type="video/mp4">
  <track kind="captions" label="English" srclang="en" :src="'/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt'" default>
  <track kind="captions" label="简体中文" srclang="zh-Hans" :src="'/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt'">
</video>

**Standalone links** (shareable without this page):

[Standalone player](https://kingdol666.github.io/AgentWorkShop/demo/player.html) ·
[Direct MP4 download](https://kingdol666.github.io/AgentWorkShop/demo/agentworkshop-core-demo.mp4) ·
[English captions (VTT)](/AgentWorkShop/demo/agentworkshop-core-demo.en.vtt) ·
[Chinese captions (VTT)](/AgentWorkShop/demo/agentworkshop-core-demo.zh-Hans.vtt) ·
[Narration audio (MP3)](/AgentWorkShop/demo/agentworkshop-core-demo-voiceover.mp3)

**Specs**: 3 min 00 s · 1920×1080 @30fps · H.264 + AAC (~13 MB, faststart) ·
English narration (Edge neural voice `en-US-AndrewNeural`, −4% rate) · EN / 简体中文 captions ·
11 scenes joined by 0.5 s fades.

### What the 2026-10 cut shows (11 scenes)

1. **Title card** — AgentWorkShop · Industrial Agent Runtime;
2. **Control-room dashboard** — live trends and the line overview;
3. **Live DAQ telemetry** — six DAQ nodes in an English ledger, 1 Hz telemetry;
4. **EDA analysis pipeline** — CSV import of 40 rows → code filter to 35 → configure → chart → online viewer → save as template;
5. **Governed tool catalog** — role/availability search across 125 tools, write-family tools all with declared reference checks;
6. **Published ontology** — overview / entities / rules / bindings / versions / compile preview tabs;
7. **Agent workspaces ×4** — multi-harness team channels and jobs;
8. **Plugin surface** — 11 loaded plugins;
9. **Analysis ledger detail** — governed write verification (proposal → approval → read-back trail);
10. **EDA studio** — scatter-chart board;
11. **Closing card**.

To go deeper on any scene: [Data workbench & EDA studio](/en/guide/eda) ·
[Ontology & AI-first model loop](/en/guide/ontology) · [HITL approvals](/en/guide/hitl) ·
[Six-protocol DAQ & control](/en/guide/daq-protocols).

### 2026-10 cut: authenticity boundary

This recording uses an isolated local environment. The line and control nodes use mock device drivers, and
telemetry is generated by the mock DAQ driver at 1 Hz. The analysis records and ontology are seeded demo data
used to show the interface and workflow. **No physical PLC is connected and no control write is issued to real
equipment.** The footage does not present a live factory run.

Footage is real screen capture (CDP screencast, 1920×1080, light theme, English UI), not a synthetic UI;
narration was generated with the Edge neural voice and every bilingual caption was reviewed per sentence.
The production log and per-scene evidence live in `docs/audit/evidence/2026-10-26-demo-video/report.md`.

## Archive

- [agentworkshop-demo.mp4 (2026-09 cut, ~2 min)](/AgentWorkShop/demo/agentworkshop-demo.mp4) —
  the earlier chaptered-cut version, superseded by the 3-minute English-UI cut above and kept for reference only.
