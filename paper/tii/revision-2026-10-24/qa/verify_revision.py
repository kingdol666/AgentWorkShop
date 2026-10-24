"""Independent, read-only verification of the compiled 2026-10-24 revision.

Writes evidence only to this QA folder. It does not rewrite the manuscript,
resources, manifests or experiments. Scholarly acceptance is outside its gate.
"""
from __future__ import annotations

import hashlib
import json
import re
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import pymupdf as fitz

QA = Path(__file__).resolve().parent
REVISION = QA.parent
ROOT = REVISION.parent / "SUBMISSION-IEEE-TII"
REPO = REVISION.parents[2]

DATA_FIGURES = {
    "fig-missions-controls.pdf": "71015341734842f0c0d44759d83a22aeaabab75f000e006ebee986c2430e5ff4",
    "fig-governance-timeline.pdf": "1147f2d1deac1fd66852d44256dfb7ba2af4d964b2ddf603bbf66d3c2ab7a4cf",
    "fig-injection-controls.pdf": "b3f818a5b0a77cf7917a1c103d1e219a1bd5c81c31685cc4e8861b0d930b2913",
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def spans(page):
    return [s for b in page.get_text("dict")["blocks"] if b["type"] == 0
            for line in b["lines"] for s in line["spans"] if s["text"].strip()]


def main():
    checks = []

    def check(name, passed, detail):
        checks.append({"name": name, "passed": bool(passed), "detail": detail})

    paths = [ROOT / "main.tex", *sorted((ROOT / "sections").glob("*.tex"))]
    sources = {p.relative_to(ROOT).as_posix(): p.read_text(encoding="utf-8") for p in paths}
    source = "\n".join(re.sub(r"(?<!\\)%.*", "", s) for s in sources.values())
    main_source = sources["main.tex"]
    pdf = ROOT / "main.pdf"
    doc = fitz.open(pdf)
    text = "\f".join(p.get_text() for p in doc)
    check("page_ceiling", 1 <= len(doc) <= 10, {"pages_including_references": len(doc), "maximum": 10})
    check("letter", all(abs(p.rect.width - 612) < .1 and abs(p.rect.height - 792) < .1 for p in doc), "US Letter 612 x 792 PDF bp")
    check("IEEEtran", r"\documentclass[journal]{IEEEtran}" in main_source, "IEEEtran journal default body geometry")
    geometry_hacks = re.findall(r"\\usepackage(?:\[[^]]*\])?\{geometry\}|\\linespread|\\(?:setlength|addtolength)\s*\{\\(?:textwidth|textheight|baselineskip|oddsidemargin|evensidemargin)\}", source)
    check("body_geometry", not geometry_hacks, geometry_hacks)
    abstract = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", main_source, re.S).group(1)
    words = re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*", abstract)
    check("abstract_length_and_shape", len(words) <= 250 and "\n\n" not in abstract.strip(), {"words": len(words), "paragraphs": len(re.split(r"\n\s*\n", abstract.strip()))})
    check("abstract_self_contained_syntax", not re.search(r"\\(?:cite|footnote|begin\{equation)\b|\$", abstract), "No references, footnotes or displayed/inline mathematical syntax")
    bibliography = (ROOT / "resources/refs.bib").read_text(encoding="utf-8")
    bbl = (ROOT / "main.bbl").read_text(encoding="utf-8")
    cited = {k.strip() for group in re.findall(r"\\cite\{([^}]+)\}", source) for k in group.split(",")}
    known = set(re.findall(r"@\w+\{([^,]+),", bibliography))
    printed = set(re.findall(r"\\bibitem(?:\[[^]]+\])?\{([^}]+)\}", bbl))
    check("citations", cited <= known and cited == printed and len(printed) == 30, {"cited": len(cited), "printed": len(printed), "missing": sorted(cited - printed), "extra": sorted(printed - cited)})
    check("resolved_pdf_references", "??" not in text, text.count("??"))
    labels = re.findall(r"\\label\{([^}]+)\}", source)
    refs = re.findall(r"\\(?:eqref|ref)\{([^}]+)\}", source)
    check("reference_anchors", not (set(refs) - set(labels)) and len(labels) == len(set(labels)), {"undefined": sorted(set(refs) - set(labels)), "duplicates": [x for x,n in Counter(labels).items() if n > 1]})
    log = (ROOT / "main.log").read_text(encoding="utf-8", errors="replace")
    bad_log = re.findall(r"[^\n]*(?:Overfull|undefined|multiply defined|Rerun to get|LaTeX Error|Missing character:)[^\n]*", log, re.I)
    check("latex_log", not bad_log, bad_log)
    newest_source = max(p.stat().st_mtime for p in paths)
    check("build_after_sources", pdf.stat().st_mtime >= newest_source and (ROOT / "main.log").stat().st_mtime >= newest_source, {"pdf_mtime": pdf.stat().st_mtime, "newest_source_mtime": newest_source})
    check("anonymous_text_metadata", not re.search(r"87287|D:\\codes|AgentWorkShop|github\.com/ABO|C:\\Users", text, re.I) and doc.metadata.get("author", "") in ("", "Anonymous Authors"), doc.metadata)
    font_rows = {font[0]: font for p in doc for font in p.get_fonts(full=True)}
    absent_fonts = [font[3] for xref,font in font_rows.items() if not doc.extract_font(xref)[3]]
    check("embedded_fonts", not absent_fonts, {"font_resources": len(font_rows), "missing": absent_fonts})
    clipped = []
    placed_figure_fonts = []
    for page_no,page in enumerate(doc,1):
        for s in spans(page):
            b = fitz.Rect(s["bbox"])
            if b.x0 < -.5 or b.y0 < -.5 or b.x1 > page.rect.width + .5 or b.y1 > page.rect.height + .5:
                clipped.append({"page": page_no, "text": s["text"], "bbox": list(b)})
            if "Arial" in s["font"]:
                placed_figure_fonts.append(s["size"])
    check("page_clipping", not clipped, clipped)
    check("placed_figure_font_floor", placed_figure_fonts and min(placed_figure_fonts) >= 8.95, {"minimum_pdf_bp": min(placed_figure_fonts) if placed_figure_fonts else None, "tolerance": "IEEE 9 TeX pt is about 8.966 PDF bp"})
    figures = []
    for options,name in re.findall(r"\\includegraphics(?:\[([^]]*)\])?\{([^}]+)\}", source):
        p = ROOT / name
        row = {"path": name, "include": options, "exists": p.is_file()}
        if p.is_file():
            fdoc = fitz.open(p)
            ss = spans(fdoc[0])
            row.update(sha256=sha(p), width_in=fdoc[0].rect.width/72, height_in=fdoc[0].rect.height/72,
                       min_font_bp=min((s["size"] for s in ss), default=0), raster_objects=len(fdoc[0].get_images()),
                       text_runs=len(ss))
        figures.append(row)
    check("six_vector_figures", len(figures) == 6 and all(f["exists"] and f.get("min_font_bp",0) >= 8.99 and f.get("raster_objects",-1) == 0 for f in figures), figures)
    sizes = {"fig-architecture-2026.pdf": (7.16,3.15), "fig-runtime-2026.pdf": (3.5,3.55)}
    wrong_sizes = [f for f in figures if Path(f["path"]).name in sizes and any(abs(x-y)>.005 for x,y in zip((f["width_in"],f["height_in"]),sizes[Path(f["path"]).name]))]
    check("redrawn_figure_sizes", not wrong_sizes, wrong_sizes)
    unchanged = {name: sha(ROOT / "resources" / name) == expected for name,expected in DATA_FIGURES.items()}
    check("experimental_artwork_unchanged", all(unchanged.values()), unchanged)
    raw_manifest = json.loads((REVISION.parent / "revision-2026-10-20/source-data-manifest.json").read_text(encoding="utf-8"))
    hashes = [{"path": r["path"], "matched": sha(REPO / r["path"]) == r["sha256"]} for r in raw_manifest["raw_sources"]]
    check("experimental_raw_sources_unchanged", all(r["matched"] for r in hashes), hashes)
    test_log = (QA / "independent-software-tests.log").read_text(encoding="utf-8", errors="replace")
    test_summary = re.findall(r"(?:tests|pass|fail|cancelled|skipped|todo) \d+", test_log)
    check("current_65_isolated_regressions", "tests 65" in test_log and "pass 65" in test_log and "fail 0" in test_log, test_summary[-6:])
    evaluation = sources["sections/evaluation.tex"]
    check("latest_boundary_disclosure", all(t in evaluation for t in ("October 23", "66", "132", "31.46")) and "eight" in evaluation and "300" in evaluation, "October 23 legacy/direct-node refusals and recipe cadence boundary, with final target shortfall")
    check("statistic_definition", "upper-median" in evaluation, "Q1 latency named upper median")
    check("honest_scope", all(t in sources["sections/discussion.tex"] for t in ("simulators", "scripted approvals", "No single current-version", "physical transfer")), "Historical/current interfaces, n=1, no complete current control-response E2E, no physical-transfer inference")
    check("AI_figure_disclosure", all(t in sources["sections/discussion.tex"] for t in ("OpenAI image generation", r"\ref{fig:arch}",r"\ref{fig:runtime}","vectors")), "AI composition and vector redrawing disclosed")
    check("no_placeholders", not re.search(r"\bTODO\b|\bFIXME\b|\[Evidence needed",source), "Source placeholder scan")
    rebuilt = QA / "independent-build/main.pdf"
    rebuild_log = (QA / "independent-build.log").read_text(encoding="utf-8", errors="replace")
    with fitz.open(rebuilt) as rebuilt_doc:
        same_text = [p.get_text() for p in doc] == [p.get_text() for p in rebuilt_doc]
        same_boxes = [list(p.rect) for p in doc] == [list(p.rect) for p in rebuilt_doc]
        check("independent_source_rebuild", "[SUCCESS]" in rebuild_log and len(rebuilt_doc) == len(doc) and same_text and same_boxes,
              {"pages": len(rebuilt_doc), "same_extracted_text": same_text, "same_media_boxes": same_boxes, "rebuilt_sha256": sha(rebuilt)})
    report = {"checked_at_utc": datetime.now(timezone.utc).isoformat(), "scope": "technical and evidence-consistency gate; not a prediction of journal acceptance", "pdf_sha256": sha(pdf), "pages": len(doc), "abstract_words": len(words), "checks": checks, "passed": all(c["passed"] for c in checks)}
    (QA / "independent-preflight.json").write_text(json.dumps(report,indent=2,ensure_ascii=False),encoding="utf-8")
    (QA / "independent-manuscript.txt").write_text(text,encoding="utf-8")
    for i,page in enumerate(doc,1):
        page.get_pixmap(matrix=fitz.Matrix(1.3,1.3),alpha=False).save(QA / f"independent-page-{i:02d}.png")
    for c in checks:
        print(("PASS" if c["passed"] else "FAIL") + " " + c["name"])
    print(f"pages={len(doc)} abstract_words={len(words)} sha256={sha(pdf)}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
