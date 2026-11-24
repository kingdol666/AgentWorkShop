# Cover Letter (Editor-Facing) — IEEE TII Initial Submission

> 使用说明（不属于信件内容；对外发送时删除本块）：
> - TII 初投清单把 cover letter 列为识别性材料：常规初投**只需上传匿名稿件 PDF**，不要把本信并入匿名稿。
> - 本信**刻意不含**作者姓名、单位、邮箱、ORCID、基金、致谢、推荐审稿人和仓库链接，以便在任何签发流程里都不破坏双盲。
> - 方括号 `[Submission date]` 由通讯作者按实际投稿日期替换；其余内容可直接使用。
> - 信中数字与当前稿件一致（10 页、6 图、4 表、24 条参考文献、55 个可写端点、220/220、219/219、216/216、110/110、60→63.7 bar、九个有效区块、三个被取消回合）。稿件若再改，请同步核对第 4 段与“Evidence boundary”。

---

Date: [Submission date]

To: The Editor-in-Chief
IEEE Transactions on Industrial Informatics

Re: Submission of a Regular Research Paper — "A Configuration-Driven Runtime for Integrating Industrial Agents With Online Data Acquisition and Governed Setpoint Operations"

Dear Editor-in-Chief,

On behalf of all authors, I submit the above manuscript for consideration as a **Regular Research Paper** in IEEE Transactions on Industrial Informatics. It is 10 pages in the IEEE double-column format with all fonts embedded, and contains 6 figures, 4 tables, and 24 references. The submitted file is anonymous and carries no author metadata.

**What the paper addresses.** Industrial agents that can read a process and propose setpoint changes are usually attached to a plant through ad hoc tool calls. Such calls rarely preserve production context, do not separate reading from writing, and blur the difference between a command the equipment accepted and the process response observed later. The manuscript treats this as a runtime problem and specifies the boundary an agent must cross before anything reaches a device.

**Contributions.** The paper makes four contributions:

- a configuration-driven production scene that binds line, product, recipe, and run context to direction-specific acquisition and control mappings, registered protocol drivers, and configured write limits, so the agent-facing interface can be re-pointed at another line without changing the governance layer;
- a single dispatch contract shared by task-mediated and direct calls, applying authorization, conditional human approval with post-approval route revalidation, and layered write guards uniformly, and recording command outcomes, device readbacks, and later process measurements as separate, verification-graded evidence;
- a mechanism-level specification — the dispatch contract, candidate clipping, the admission interval, and the accompanying procedure — detailed enough that the boundary can be reimplemented and tested independently of any particular agent or language model;
- an evidence-bounded evaluation: 55 write-capable endpoints across four simulated scenes and the five registered protocol families (Modbus TCP, Modbus RTU, OPC UA, MQTT, HTTP), with 220/220 expected acceptances, 219/219 collected structural rejections, 216/216 matching readbacks, and 110/110 recipe-window rejections; guard and approval-route fixtures; an injection-twin write from 60 to 63.7 bar with matching readback; an exploratory nine-block scripted-versus-no-write comparison; and three language-model-driven episodes canceled before reaching the target band.

**Evidence boundary we state explicitly.** All reported results are simulator or mock-driver results. The paper does not claim general control efficacy, autonomous convergence, a complete correlated agent-to-device trace, or physical-plant safety; the batch-selection rule of the exploratory comparison is reported as unresolved. These limits are part of the argument: the contribution is the governed execution boundary and the evidence discipline around it, not a performance claim for a particular controller.

**Planned work: closed-loop optimization control.** This boundary is the substrate for the next stage of the work, which we are pursuing on both the research and the practice side. On the research side, we are extending the runtime into closed-loop optimization control: a lead agent that dispatches bounded, individually approved exploration steps, reassesses the retained evidence after each step, and decides whether to continue, revert, or stop, together with a process-experience memory that reuses validated context, intents, and outcomes to condition later proposals. Both extensions stay inside the same dispatch, approval, and revalidation checks and confer no additional write authority. On the practice side, the plan is a prespecified study on a physical line with verified resets, a named controller baseline, common sampling and horizons, and correlated observation-to-intent-to-device records, so that approval effects and physical safety are examined as separate questions rather than inferred from simulator behaviour. We see this paper as the measurement and governance foundation that closed-loop work needs before autonomy can be defended.

**Declarations.** The manuscript is not under consideration elsewhere, has not been published elsewhere, and all authors have approved this submission. The authors declare no competing interests. The manuscript discloses that generative AI assisted with language polishing and LaTeX typesetting, and that the cast-film machine row in Fig. 1 is a text-to-image composite with vector annotations; the authors remain responsible for the content. No supplementary file is submitted with the initial manuscript. Should the editorial office require details of any earlier circulation of the manuscript or of the author-side evidence records, including a dated console walk-through of the implemented path that is not part of the claims, we will provide them directly and privately.

Thank you for considering this submission.

Sincerely,
On behalf of all authors
