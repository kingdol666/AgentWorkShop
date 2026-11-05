# Fig. 3 可编辑源文件

- `fig3-editable.drawio`：可在 diagrams.net / draw.io 中通过 **File → Open** 打开的原生图形文件。框、文本和连接线都是独立对象，颜色和布局可编辑。
- `fig3-xmind.opml`：OPML 格式的节点树，可用支持 OPML 导入的 XMind 版本通过 **Import → OPML** 导入。它表达与图相同的节点及分组，不是内嵌的 PNG。不同版本的菜单名称可能不同；不支持 OPML 导入的版本可通过其他支持 OPML 的思维导图工具转换。
- `fig3-layout-preview.svg`：由相同对象与坐标生成的布局预览，便于在普通浏览器中查看；它是近似渲染，自动连接线路径不一定与 draw.io 打开时完全相同，正式修改请使用 `.drawio`。
- `fig3-process-write-runtime.pdf`：从上述 SVG 生成的矢量 PDF，已由当前主稿 `sections/closedloop.tex` 引用。它不是 diagrams.net 原生导出；在 draw.io 中修改后，请从修改后的源重新导出并检查论文中的最终尺寸。
- `fig3-process-write-runtime.png`：该 PDF 的预览栅格图，供快速查看，不作为论文图源。
- `generate_sources.py`：两种源文件的生成脚本，在本目录运行 `python generate_sources.py` 可重新生成。重新生成会覆盖同名源文件，因此手工修改后的文件应先另存。

## 内容与映射

以当前论文 Fig. 3 的设计语义为准：任务与生产上下文 → 提议 → 共享分发；需要审批的路径进入条件审批和 **Approved?** 菱形，Yes 经独立的 Revalidation 后进入写入约束，No 进入 Stop / Rejected，终止于驱动调用前。无审批路径沿虚线绕过审批与审批后的复核，进入同一写入约束，再到驱动与过程。命令状态/可选设备回读和 DAQ 过程观测分开。派发前被拒或超时不会调用驱动，但驱动阶段报错时设备可能已发生变化，必须核对设备状态。状态、回读和过程目标分别判读。该图是概念流程，不宣称成功的 live-Agent 实验。

OPML 中每个节点的 `_drawio_id` 对应 draw.io 中同名的对象 ID。OPML 表达树形层级，无法可靠保留 draw.io 的跨支路箭头、边路径、颜色和坐标；重新编辑工作流方向与回环请使用 `.drawio`。图中没有论文实验数据；修改图后需要同步更新 PDF 和 `closedloop.tex` 引用。

## 验证范围

源文件经过 XML 解析、节点 ID 与连接引用检查；SVG 预览在浏览器中检查了分层、颜色和主要连线。所有可见文本的绘图字号至少为 23，按 1440 单位画布缩放到 7.16 英寸全栏宽度估算约为 8.23 pt；该估算不代替对实际导出 PDF 的测量。尚未在本机 draw.io 或 XMind 应用中做导入验证。原图参考 `../../fig3-governed-agent-runtime-20261105.png`；此版本是根据论文结构重建的可编辑图，不保证与它或其他参考附件像素级一致。若用于论文，须在最终缩放尺寸下重新核对字高与连线。
