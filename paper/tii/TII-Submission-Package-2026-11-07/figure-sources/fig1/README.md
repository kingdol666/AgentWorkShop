# Figure 1: cast-film running example

The figure pairs a cast-film line illustration generated through Codex's built-in image tool (GPT Image 2.6 requested; no API subvariant was exposed) with code-authored, editable labels, cards, and connectors. It distinguishes the MQTT line-speed control node from the MQTT film-thickness measurement node, then shows command receipt, optional setpoint readback, and later DAQ observation as separate evidence.

`generate_fig1_gptimage26.py` composes the active PDF, SVG, and 600-dpi PNG in the central `figures/` folder and refreshes `fig1_cast_film.drawio`. The generated illustration is retained as `fig1-gptimage26-base.png`; the generation prompt is in `gptimage26-prompt-20261107.md`. `build_figures.py` remains a backward-compatible entry point. Rebuilding does not call the image generator; it uses the retained base image. The draw.io source embeds the illustration as a raster object while all text and connectors remain editable.

The final PDF is one-column width (3.5 in), uses embedded Times New Roman text at a minimum of 9.3 pt before manuscript placement, and retains the illustration at more than 450 effective dpi. The manuscript scales it to 0.98 column width. `archive/20261107-before-gptimage26/` preserves the prior artwork and OPML hierarchy.
