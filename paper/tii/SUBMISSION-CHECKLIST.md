# TII 投稿前必办清单(仅作者本人可完成的三件事 + 提交步骤)

> 稿件本体已就绪:`main.pdf`(12 页 ≤14)、0 未解析引用、五席盲审全 SATISFIED、
> 仓库已推送(88c7f9a)、CITATION.cff 就位。以下三步完成后即可在 IEEE Scholar 提交。

## ① 作者块与经费(main.tex)

- [ ] 第 60-62 行:`First~Author, Second Author...` → 真实作者列表
      (姓名、单位、城市、国家、邮箱;通讯作者标注)
- [ ] `Manuscript received XXXX; revised XXXX.` → 由 IEEE Scholar 提交后系统生成,可留待校样
- [ ] 经费/致谢:`sections/discussion.tex` 之后 `\section*{Acknowledgments}` 内
      `% TODO(submission): fill funding/acknowledgment text.` → 填项目基金号或删除该占位注释
- [ ] CITATION.cff 的 authors.alias `AgentWorkShop Authors` → 同步真实作者
- [ ] 重编译:`latexmk -pdf main.tex`(确认 0 undefined、页数不变)

## ② Artifact DOI(Zenodo)

- [ ] 登录 https://zenodo.org → Account → GitHub → Connect,勾选
      `kingdol666/AgentWorkShop` 仓库 → Create release 触发铸 DOI
- [ ] (仓库已含 CITATION.cff,GitHub 侧也可生成 "Cite this repository")
- [ ] 拿到 DOI 后替换 `sections/discussion.tex` 尾部:
      `% TODO(submission): add the artifact DOI.` →
      `Artifact DOI: \url{https://doi.org/10.5281/zenodo.XXXXXXX}`(放脚注)
- [ ] 建议同时给 `plc-node-simulator` 子仓库打 tag 发布

## ③ 提交 IEEE Scholar

- [ ] https://ieee.atyponrex.com (TII 投稿入口) 创建稿件:Regular Paper
- [ ] 上传 main.pdf + main.tex 源文件包(含 figures/、refs.bib、results-macros.tex)
- [ ] Cover letter:见同目录 `cover-letter-draft.md`(填姓名日期后使用)
- [ ] 建议推荐审稿人 3-5 名(工业信息物理/LLM-agent 方向)
- [ ] 提交前最后跑一次 `latexmk -pdf main.tex` 确认 0 错误

## 可选加分项(有条件即做)

- [ ] 提供 GLM_API_KEY(环境变量)→ 补测 B2 外部基线臂(LangGraph/AutoGen 经同一 MCP
      工具面跑 T1/T2),EIC 明言此实验会把推荐升至 enthusiastic accept
- [ ] L3 物理设备实测(一个 OPC UA/Modbus 真设备的写-回读时延)
- [ ] LLM campaign 跨种子复测(消除单种子方差质疑)
