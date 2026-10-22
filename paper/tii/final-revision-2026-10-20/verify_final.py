"""Inspect the actual final PDF, active sources and immutable result definitions.

Local preflight only; this does not implement the academic reviewer checker.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import zipfile
from pathlib import Path

import pymupdf as fitz

HERE = Path(__file__).resolve().parent


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def plain(source):
    return re.sub(r"(?<!\\)%.*", "", source)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=HERE.parent / "SUBMISSION-IEEE-TII")
    parser.add_argument("--out", type=Path, default=HERE / "qa")
    parser.add_argument("--render", action="store_true")
    args = parser.parse_args()
    root, out = args.root.resolve(), args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    paths = [root / "main.tex", *sorted((root / "sections").glob("*.tex"))]
    sources = {p.relative_to(root).as_posix(): p.read_text(encoding="utf-8") for p in paths}
    main_source = sources["main.tex"]
    combined = "\n".join(plain(s) for s in sources.values())
    pdf_path = root / "main.pdf"
    doc = fitz.open(pdf_path)
    checks = []

    def check(name, passed, detail):
        checks.append({"name": name, "passed": bool(passed), "detail": detail})

    check("ten_pages", len(doc) == 10, len(doc))
    check("letter", all(abs(p.rect.width - 612) < .1 and abs(p.rect.height - 792) < .1 for p in doc), "612 x 792 PDF bp")
    check("IEEEtran", r"\documentclass[journal]{IEEEtran}" in main_source, "journal class")
    check("no_body_geometry_hacks", not re.search(r"\\usepackage(?:\[[^]]*\])?\{geometry\}|\\linespread|\\(?:setlength|addtolength)\s*\{\\(?:textwidth|textheight|baselineskip|oddsidemargin|evensidemargin)\}", combined), "body geometry/leading")
    abstract = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", main_source, re.S).group(1)
    words = re.findall(r"[A-Za-z0-9]+(?:[-'][A-Za-z0-9]+)*", abstract)
    check("abstract", 150 <= len(words) <= 250 and "\n\n" not in abstract.strip(), len(words))
    cited = {key.strip() for group in re.findall(r"\\cite\{([^}]+)\}", combined) for key in group.split(",")}
    bibliography = (root / "resources/refs.bib").read_text(encoding="utf-8")
    known = set(re.findall(r"@\w+\{([^,]+),", bibliography))
    bbl = (root / "main.bbl").read_text(encoding="utf-8")
    printed = set(re.findall(r"\\bibitem(?:\[[^]]+\])?\{([^}]+)\}", bbl))
    check("citation_keys", cited <= known and cited == printed, {"cited": len(cited), "printed": len(printed), "missing": sorted(cited - printed)})
    log = (root / "main.log").read_text(encoding="utf-8", errors="replace")
    errors = re.findall(r"[^\n]*(?:Overfull|undefined|multiply defined|Rerun to get|LaTeX Error|Missing character:)[^\n]*", log, re.I)
    check("build_log", not errors, errors)
    text = "\f".join(p.get_text() for p in doc)
    check("no_missing_refs", "??" not in text, text.count("??"))
    check("anonymous", not re.search(r"87287|D:\\codes|AgentWorkShop|github\.com/ABO", text, re.I) and doc.metadata.get("author", "") in ("", "Anonymous Authors"), doc.metadata.get("author"))
    font_resources = {r[0]: r for p in doc for r in p.get_fonts(full=True)}
    absent_fonts = [r[3] for x, r in font_resources.items() if not doc.extract_font(x)[3]]
    check("embedded_fonts", not absent_fonts, {"count": len(font_resources), "missing": absent_fonts})
    clipped, placed_figure_type = [], []
    for page_number, page in enumerate(doc, 1):
        for block in page.get_text("dict")["blocks"]:
            if block["type"] != 0:
                continue
            for line in block["lines"]:
                for span in line["spans"]:
                    if not span["text"].strip():
                        continue
                    b = fitz.Rect(span["bbox"])
                    if b.x0 < -.5 or b.y0 < -.5 or b.x1 > page.rect.width + .5 or b.y1 > page.rect.height + .5:
                        clipped.append({"page": page_number, "text": span["text"], "bbox": list(b)})
                    if "Arial" in span["font"]:
                        placed_figure_type.append(span["size"])
    check("page_bounds", not clipped, clipped)
    check("placed_figure_type", bool(placed_figure_type) and min(placed_figure_type) >= 8.95, {"minimum_pdf_bp": min(placed_figure_type) if placed_figure_type else None, "minimum_tex_pt": min(placed_figure_type) * 72.27 / 72 if placed_figure_type else None, "native_target": "9 PDF bp; approximately 9 TeX pt after IEEE placement"})
    figures = []
    for options, name in re.findall(r"\\includegraphics(?:\[([^]]*)\])?\{([^}]+)\}", combined):
        path = root / name
        row = {"path": name, "options": options, "exists": path.is_file()}
        if path.is_file():
            with fitz.open(path) as fdoc:
                page = fdoc[0]
                spans = [s for b in page.get_text("dict")["blocks"] if b["type"] == 0 for line in b["lines"] for s in line["spans"] if s["text"].strip()]
                row.update(sha256=sha(path), width_in=page.rect.width / 72, height_in=page.rect.height / 72, minimum_pdf_bp=min(s["size"] for s in spans), raster_objects=len(page.get_images(full=True)))
        figures.append(row)
    check("active_figures", len(figures) == 6 and all(f["exists"] and f.get("minimum_pdf_bp", 0) >= 8.99 and f.get("raster_objects", -1) == 0 for f in figures), figures)
    expected_sizes = {"fig-architecture-2026.pdf": (7.16, 3.15), "fig-runtime-2026.pdf": (3.5, 3.55)}
    size_errors = [f["path"] for f in figures if Path(f["path"]).name in expected_sizes and any(abs(v - e) > .005 for v, e in zip((f["width_in"], f["height_in"]), expected_sizes[Path(f["path"]).name]))]
    check("redesigned_sizes", not size_errors, size_errors)
    check("no_placeholders", not re.search(r"\bTODO\b|\bFIXME\b|\[Evidence needed", combined), "visible source")
    with zipfile.ZipFile(HERE / "baseline-source.zip") as baseline:
        protected_changes = []
        for name, current in sources.items():
            previous = baseline.read(name).decode("utf-8").replace("\r\n", "\n")
            for label, pattern in [("labels", r"\\label\{[^}]+\}"), ("equations", r"\\begin\{equation\}.*?\\end\{equation\}")]:
                if re.findall(pattern, plain(previous), re.S) != re.findall(pattern, plain(current), re.S):
                    protected_changes.append({"file": name, "category": label})
        previous_macros = baseline.read("resources/results-macros.tex").decode("utf-8")
        current_macros = (root / "resources/results-macros.tex").read_text(encoding="utf-8")
        check("protected_definitions", not protected_changes and plain(previous_macros).split() == plain(current_macros).split(), protected_changes)
        check("bibliography_unchanged", baseline.read("resources/refs.bib") == (root / "resources/refs.bib").read_bytes(), "same verified bibliography")
    (out / "manuscript.txt").write_text(text, encoding="utf-8")
    if args.render:
        for i, page in enumerate(doc, 1):
            page.get_pixmap(matrix=fitz.Matrix(1.5, 1.5), alpha=False).save(out / f"page-{i:02d}.png")
    report = {"scope": "local technical preflight, not journal acceptance", "pdf_sha256": sha(pdf_path), "pages": len(doc), "abstract_words": len(words), "references": len(printed), "checks": checks, "passed": all(c["passed"] for c in checks)}
    (out / "final-preflight.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    manifest_paths = [*paths, pdf_path, root / "resources/refs.bib", root / "resources/results-macros.tex", root / "main.bbl", *(root / f["path"] for f in figures)]
    manifest = {"entrypoint": "main.tex", "output": "main.pdf", "pages": len(doc), "recorded_on": "2026-10-20", "files": {p.relative_to(root).as_posix(): sha(p) for p in manifest_paths}}
    (root / "FILE-MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    for c in checks:
        print(("PASS" if c["passed"] else "FAIL") + " " + c["name"])
    print(f"pages={len(doc)} abstract={len(words)} refs={len(printed)} sha256={sha(pdf_path)}")
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
