# 2026-09-16 全卡冷启动实测归档

来源 runId(均在 bench/results/ 永不覆盖):
- static  20260916144341-1718 — 100/100 (pass 3)
- pipeline A 20260916144350-18no — 54/1warn/0(fail) PASS;line-3 首轮写瞬态
- pipeline B 20260916150300-15ns — 55/0/0 PASS(执行卡标准)
- plc     20260916145922-xac — 13/13, 100/100
- e1lite  20260916150036-e1lite — 四臂判据全符合
- api-live-e2e: ALL PASS (60)

复现判定:
- plc vs 20260914-baseline/run-plc-fx0 = REPRODUCIBLE
- e1lite vs 20260914-baseline/run-e1lite-4arm = REPRODUCIBLE
- pipeline B vs 论文引用 run 20260914152838-fwg = REPRODUCIBLE
- A/B portability.agg 逐字段一致;B 闭环 agg ratio ∈ [0.967,0.969] ⊂ [0.966,0.973]
- compare --selftest = PASS(正确拒绝篡改)

环境备注:本机 verge-mihomo 代理外连 churn 间歇占满回环临时端口池,
bench 侧以 8 次退避重试吸收(plc-scenario.mjs simApi 本次同步加固)。
