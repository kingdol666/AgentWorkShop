"""Package active LaTeX sources; experimental evidence is a separate ZIP."""
from pathlib import Path
import hashlib
import json
import re
import zipfile

HERE = Path(__file__).resolve().parent
PAPER = HERE.parent / "SUBMISSION-IEEE-TII"
PRIOR = HERE.parent / "revision-2026-10-20-tenpage"
DATA = HERE.parent / "revision-2026-10-20"


def digest(data):
    return hashlib.sha256(data).hexdigest()


def anonymous_text(value):
    # Names/paths in copied audit material are not scientific observations.
    value = re.sub(r"(?i)(?<![A-Za-z0-9])[A-Z]:[\\/](?![\\/])(?:[^\s\"<>`]+)", "[local-path]", value)
    value = re.sub(r"(?i)C:/Users/[^/\s]+", "[local-user]", value)
    for item in ("87287", "AgentWorkShop", "Diane Williams", "kingdol666", "kingdol"):
        value = value.replace(item, "[redacted-identity]")
    value = re.sub(r"https://github\.com/(?:ABO|[A-Za-z0-9_-]+/AgentWorkShop)[^\s)\"]*", "[repository-withheld]", value, flags=re.I)
    return value


def main():
    paths = [PAPER / "main.tex", *sorted((PAPER / "sections").glob("*.tex"))]
    joined = "\n".join(p.read_text(encoding="utf-8") for p in paths)
    figures = [PAPER / x for x in re.findall(r"\\includegraphics(?:\[[^]]*\])?\{([^}]+)\}", joined)]
    local = [*paths, *figures, *(x.with_suffix(".svg") for x in figures), PAPER / "main.pdf", PAPER / "main.bbl", PAPER / "resources/refs.bib", PAPER / "resources/results-macros.tex", PAPER / "figures/make-system-2026.py", PAPER / "figures/make-evaluation-2026.py", PAPER / "README.md", PAPER / "REPRODUCIBILITY.md", PAPER / "CLAIM-EVIDENCE-LEDGER.md", PAPER / "FILE-MANIFEST.json"]
    files = {p.relative_to(PAPER).as_posix(): p for p in dict.fromkeys(local)}
    files.update({"figure-source-data/" + p.name: p for pattern in ("source-data-*.json", "source-data-*.csv") for p in sorted(DATA.glob(pattern))})
    for name in ("REFERENCE-USAGE-VERIFICATION.md", "CITATIONS-01-15.md", "CITATIONS-16-29.md", "citations-01-15.json", "citations-16-29.json", "BIBLIOGRAPHY-CHANGES.json"):
        files["reference-audit/" + name] = PRIOR / name
    files["reference-audit/IEEE-REQUIREMENTS.md"] = HERE / "IEEE-REQUIREMENTS.md"
    payload, transformations = {}, {}
    for name, path in files.items():
        raw = path.read_bytes()
        data = raw
        if path.suffix.lower() in (".md", ".json", ".py", ".tex", ".bib", ".csv", ".svg", ".bbl"):
            original = raw.decode("utf-8-sig")
            cleaned = anonymous_text(original)
            data = cleaned.encode("utf-8")
        payload[name] = data
        if data != raw:
            transformations[name] = {"original_sha256": digest(raw), "delivered_sha256": digest(data), "rule": "identity/path redaction or UTF-8 BOM normalization in delivery copy"}
    payload["EVIDENCE-PACKAGE.txt"] = ("Experimental archives, original engine logs, replay snapshots and claim mappings are in the separately delivered IEEE-TII-anonymous-evidence.zip. See its README, MANIFEST, CLAIM-MAP and MISSING-EVIDENCE. No process experiment was rerun for this revision.\n").encode()
    private_tokens = []
    for name, data in payload.items():
        if name.endswith(".pdf"):
            continue
        text = data.decode("utf-8", errors="replace")
        if re.search(r"87287|Diane Williams|AgentWorkShop|kingdol|[A-Za-z]:[\\/]Users[\\/]|[A-Za-z]:[\\/]codes[\\/]", text, re.I):
            private_tokens.append(name)
    if private_tokens:
        raise RuntimeError("Private identity/path in copied source package: " + repr(private_tokens))
    assert payload["resources/refs.bib"] == (PAPER / "resources/refs.bib").read_bytes(), "Published citation metadata must remain byte-identical"
    assert payload["main.bbl"] == (PAPER / "main.bbl").read_bytes(), "Rendered citation text must remain byte-identical"
    # FILE-MANIFEST describes delivered copies, not private originals.
    artifact_manifest = {"entrypoint": "main.tex", "output": "main.pdf", "pages": 10, "recorded_on": "2026-10-20", "files": {n: digest(b) for n, b in payload.items() if n != "FILE-MANIFEST.json"}}
    payload["FILE-MANIFEST.json"] = json.dumps(artifact_manifest, indent=2).encode()
    zip_path = HERE / "IEEE-TII-manuscript-source.zip"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for name, data in payload.items():
            z.writestr(name, data)
    with zipfile.ZipFile(zip_path) as z:
        assert z.testzip() is None
        assert all(digest(z.read(n)) == digest(b) for n, b in payload.items())
    manifest = {"date": "2026-10-20", "package": zip_path.name, "sha256": digest(zip_path.read_bytes()), "bytes": zip_path.stat().st_size, "scope": "active anonymous LaTeX build and figure source data; separate experimental-evidence supplement", "files": {n: digest(b) for n, b in payload.items()}, "copied_transformations": transformations, "privacy_scan": "PASS (bounded explicit identities and local path patterns)"}
    (HERE / "DELIVERY-MANIFEST.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"PASS: {zip_path.name}, {len(payload)} files, {zip_path.stat().st_size} bytes, sha256={manifest['sha256']}")


if __name__ == "__main__":
    main()
