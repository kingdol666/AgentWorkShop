# IEEE TII Submission Package

This curated package contains the current anonymous-review manuscript, its five included figures, Supplementary File S7 and associated evidence archives, editable figure sources, and documentation needed to interpret the evidence. Historical drafts, unselected figures, and stale archives are kept outside this package. The build script writes temporary TeX outputs under `build/`; these are excluded from `manifest.json` and should be omitted when archiving the submission copy.

## Folder map

- `manuscript/`: `main.tex`, the S7 source, section files, bibliography, IEEEtran style files, and the compiled manuscript PDF.
- `figures/`: the five active paper figures. Figure 1 is a composite PDF with a Codex-generated cast-film illustration (GPT Image 2.6 requested; no API subvariant was exposed) and code-authored vector labels; Figures 4 and 5 use vector PDFs; Figures 2 and 3 use the enhanced raster PNGs supplied for the paper. PNG previews and SVG exports are kept beside the PDF figures.
- `supplementary/`: the compiled S7 PDF and the core, follow-up, and selected Agent evidence archives. Follow-up batches are separate and are not pooled with the core batch.
- `figure-sources/`: editable sources for vector figures, plus the supplied Figure 2/3 references, enhancement prompts, and intermediate images. Figures 2 and 3 remain raster artwork; their earlier vector redraws are archived outside this package.
- `documentation/`: reproducibility notes, evidence and citation audits, experiment design, the E0--E7 execution contract, and the AI-use disclosure draft.
- `reproducibility-tools/`: the offline collector, trajectory validator, E7 schedule/inventory utilities, and their tests. These tools do not contact a model, harness, simulator, or plant.
- `tools/`: package build and manifest verification scripts.

## Build

From the package root, run the included PowerShell build script:

```powershell
& .\tools\build-paper.ps1
```

It compiles both TeX entry points into a separate `build/` directory and refreshes the packaged PDFs. The package manifest must then be regenerated:

```powershell
python .\tools\update-manifest.py
python .\tools\verify-manifest.py
```

The compiled manuscript is 10 pages; the Supplementary File S7 page count is recorded in `manifest.json` after the final build. The manifest hashes the package files and excludes itself; it identifies this curated package snapshot, not a frozen runtime revision.

To regenerate Figure 1 and vector Figures 4 and 5, run `& .\tools\regenerate-figures.ps1` from the package root, then rebuild the manuscript and regenerate its manifest. Figure 1 uses its retained GPT Image base; the generation script does not make a new image-generation request. Figures 2 and 3 are preserved user-supplied raster diagrams and are not overwritten by this script. Figure 5 uses the E6/E7 archive for fixed-horizon pairs and the core archive for guard ablation.

From the package root, run `python .\tools\audit-manuscript.py`, `python .\tools\audit-figures.py`, and `& .\tools\test-reproducibility-tools.ps1` to check citations, figure paths/fonts, and offline-tool behavior. These checks validate document/package consistency; they are not new experimental results.

## Figure and evidence notes

The supplied Figure 2 and Figure 3 images are 1774 × 887 pixels and have no resolution metadata. They were enhanced with GPT Image for contrast and legibility, then processed with the Real-ESRGAN x4plus-anime model to produce 7096 × 3548 px PNGs. At IEEE's 7.16-inch two-column width, the delivered images provide about 991 effective pixels per inch. IEEE accepts PNG and specifies more than 300 dpi for color/grayscale images and more than 600 dpi for black-and-white line art. IEEE also cautions that ordinary upscaling alone does not restore image detail; these files are therefore described as model-assisted super-resolution of the supplied images, and their labels and flow were checked against the originals and manuscript. IEEE recommends type at approximately 9–10 pt at final size. The supplied raster diagrams have dense labels; super-resolution improves sampling and contrast but does not enlarge their point size, so strict compliance with that typography recommendation is not claimed. Figure 1's code-authored labels use embedded Times New Roman at 9.3 pt in the 3.5-inch PDF source and remain approximately 9.1 pt at the manuscript's 0.98-column placement. Its embedded color illustration exceeds 450 effective dpi at that placement. Figure 1 therefore meets the 9–10 pt full-size type recommendation while retaining the distinction between generated artwork and exact, editable labels. Figures 4 and 5 remain vector PDFs with embedded Times New Roman text. See IEEE's [graphics resolution and size guidance](https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-graphics-for-your-article/resolution-and-size/) and [file-format guidance](https://journals.ieeeauthorcenter.ieee.org/create-your-ieee-journal-article/create-graphics-for-your-article/file-formatting/).

The package archives an exploratory E6 fixed-horizon subset (9 valid of 11 post-pilot pairs) and a three-episode E7 simulator pilot (all canceled and below the target band; write counts are recorder-reported). The included E6/E7 utilities validate records and enumerate planned episodes but do not acquire new runs or call a model. The earlier 15/15 versus 0/15 endpoint result is retained as historical descriptive evidence only. Approval fixtures do not establish operator decision quality, and simulator/mock-driver checks do not establish field safety.

The AI-use disclosure is a draft for author confirmation. IEEE's [AI-use guideline](https://open.ieee.org/author-guidelines-for-artificial-intelligence-ai-generated-text/) requires disclosure of AI-generated content used in a submitted article; the anonymous-review submission system's disclosure field still requires author confirmation.
