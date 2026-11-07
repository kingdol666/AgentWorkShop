# Revision notes: system narrative and Figure 3

This revision addresses the non-experimental review of the manuscript's story,
contribution, system description, and figure-to-text consistency.

- The abstract, introduction, related work, and conclusion now explain the
  configuration, route-dependent checks, and evidence separation as a system
  integration contribution. They do not claim that its individual components
  or an agent decision algorithm are new.
- The system section uses the archived cast-film simulator's line-speed
  control and film-thickness acquisition mappings as a concrete example.
  It distinguishes production context supplied to a task from checks at the
  write boundary.
- The operation section distinguishes later-source identifiability and
  model/ontology checks from the November 1 batch whose manifests report
  `da627d21`. The active services in that batch were not captured as a
  hermetic snapshot. It also distinguishes later DAQ windows from the earlier
  source's trailing 45-second reads.
- The governance section and Figure 4 describe the source- and mode-dependent
  step, interval, and hold checks, the additional trial-override recipe-window
  check, and possible partial batch results. They do not assert atomic writes.
- Figure 3 was redesigned from an image-generated concept and redrawn as a
  vector illustration with executable source. Approval is conditional, device
  readback is optional, and process observations are separate from command
  status. The figure depicts a conceptual path, not an observed successful
  live-Agent run.
- The main-text table of exact per-seed endpoints duplicated Fig. 5 and Table 3
  of Supplementary File S7. The duplicate table was removed to retain the
  ten-page manuscript; the complete numerical table remains in S7 and the raw
  CSVs remain in the frozen evidence archive.

No experiment was rerun or generated for this revision. Existing limitations
on mismatched horizons, unavailable live-Agent writes, provenance and physical
deployment remain in the manuscript. The AI-use disclosure is a draft for
author verification and the journal's current submission channel.
