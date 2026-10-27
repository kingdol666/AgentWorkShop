# V3 手动档回执(ivh6ki)

试验已整批下发并全部设备证实(1/1,批次 rr-7f5d9):一段桶温SP-ivh6ki→238℃ [证实✓]。假设:V3 依据:熔温 246.7℃ 高于目标带,SP 240→238 小步下探(ivh6ki)。
人工附言:验收员批准:238℃ 合规,观察响应注意:本次试验**未写入配方版本** —— 等待工艺惯性后 daq_query 复测判读:有进步/达标 → recipe_update 把候选值固化进配方(同 id 版本+1);无进步/劣化 → recipe_rollback(recipe_id, dispatch=true, reason=…) 统一回退(定义回退+PLC 整批恢复)。
