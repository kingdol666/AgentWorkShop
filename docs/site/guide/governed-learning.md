# 受治理的产品经验复用

v0.14.0 起，RSI 经验在"不可变版本 + 统一解析器 + 发布门"三层的治理下运行：一条经验从产生到被 Agent 使用，要经过 **版本化 → 证据门 → 人审 → 发布 → 注入** 五个可审计的阶段，且每一步都可以独立撤回。

## 版本生命周期

- 每条经验写入 `experience_versions`：正文与证据快照哈希只插不改；正文/证据/范围变化创建新 `candidate` 版本（CAS 指针，并发冲突返回 `EXPERIENCE_VERSION_CONFLICT`）。
- 生命周期 `candidate → evaluating → validated` 与部署 `none → shadow → canary → active` **相互独立**；验证状态不等于部署状态。
- 升级迁移把既有经验行回填为 `legacy-unverified`（历史 `retired` 保持 `retired`）——没有可解析来源的旧行**不继承部署许可**，永不自动注入。

## 统一解析器

所有读取面（自动注入、主动检索、审阅投影）共用同一个入口，按顺序闸：

1. **授权 epoch**：成员/角色/绑定/产品/经验权限突变推进持久 epoch，不匹配即拒绝（`EPOCH_STALE`）；
2. **作用域硬过滤**：line/product 经验只在当前产品与配方版本匹配时可见，未知不扩域；
3. **用途分级**：`automatic` 只返回 `validated` + `canary/active`；`explicit` 可见未部署的 validated 但标记为参考；`review` 才可见候选。

撤权、切产品或退休后，旧内容在下一回合即停止注入（overlay 缓存键含 epoch）。

## 证据与晋升

- 证据按**宿主派生支持单元**（run/批次/种子）计独立性：同源重试、分片、复述曾注入的主张都不计新增；
- 主张簇按产品、变量、量纲、方向、工况与配方版本判相容；Beta 派生物与 legacy 行不可进入晋升簇；
- 晋升 `validated` 需要证据门（≥2 独立支持单元、任务证据完整）通过。

## 发布与撤销

- 晋升 `active` 必须引用**宿主来源评测**（`host-evaluation` 台账行，携带真实 C−B 测量）；客户端自报评测只读展示；
- 发布 = 待发布请求 + 审计 outbox（同一事务）→ 审计确认 → CAS 激活；请求人与审阅人不得相同（maker-checker）；
- 同一作用域单 active：新版本激活时旧版本自动 `withdrawn`；撤销只停注入、不改写已审事实。

## 产线写尝试账本

每次产线写围绕 `prepared → dispatched → verified | rejected | not_sent | unknown` 持久记账。进程中断后重启对账：`prepared` → `not_sent`（驱动未被调用），`dispatched` → `unknown`（可能已生效）。**`unknown` 一律不自动重发**，必须独立核实；旧批准在代次/租约/上下文/载荷任一不符时拒绝复用。

## Project 计划进度

项目 observability 暴露 `planProgress`（`pending_approval / applied / rejected / attention_required`）；待批计划窗口内，与计划冲突的手工建项被 `PLAN_CHANGE_PENDING` 拒绝，不冲突的手工路径保留。

## 边界（务必阅读）

- 经验是**低可信参考数据**，不是系统指令、工具授权、设备写权限或安全限值的权威；
- 部署必须经人工发布门；`shadow` 只进隔离评估；`legacy-unverified` 永不自动注入；
- 模拟证据不等于物理 HIL 或生产投用；收益验证需要冻结协议下的独立前瞻样本；
- 现场准入走[独立清单](./governed-industrial-pilot-admission-template)，与本文档的软件结论分开。

## 相关文档

- [实施计划与验收口径](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/superpowers/plans/2026-11-20-governed-product-learning-and-industrial-readiness.md)
- [主干审计报告](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/governed-product-learning-main-audit.md)
- [隔离模拟验收报告](https://github.com/kingdol666/AgentWorkShop/blob/main/docs/audit/governed-product-learning-acceptance.md)
- [RSI 经验演化](./rsi)
