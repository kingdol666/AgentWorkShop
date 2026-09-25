# AML Hybrid Twin Acceptance

- generatedAt: 2026-09-25T03:04:10.670Z
- real DCW writes: 0
- undertrained mode: safe_small_step (correctly blocked)
- trained mode: precise_search (gates passed)
- recommendation issued: true
- candidateExecuted: false
- unsafe candidate rejected: false
- stale snapshot rejected: true

## Control policy

训练门禁未通过时仅允许 safe_small_step 试探，用于收集数据；只有训练、UQ/OOD、物理和候选轨迹门禁全部通过时，才允许 precise_search recommendation。所有推荐均为 recommendation-only，未写入 PLC/DCW。