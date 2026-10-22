"""Local review grammar subset; NOT the unavailable canonical ARS checker."""
from pathlib import Path
import json
import re

HERE = Path(__file__).resolve().parent


def main():
    contract = json.loads((HERE / "contract.json").read_text(encoding="utf-8"))
    results = []
    for role in ("eic", "methodology", "domain", "perspective", "da"):
        p1 = HERE / f"{role}-phase1.md"
        p2 = HERE / f"{role}-phase2.md"
        errors = []
        if not p1.is_file() or not p2.is_file():
            results.append({"role": role, "status": "MISSING", "missing": [p.name for p in (p1, p2) if not p.exists()]})
            continue
        a, b = p1.read_text(encoding="utf-8"), p2.read_text(encoding="utf-8")
        expected = [(d["id"], d["name"]) for d in contract["acceptance_dimensions"] if role in d["eligible_roles"]]
        if re.findall(r"^## (.+)$", a, re.M) != ["Contract Paraphrase", "Scoring Plan"]:
            errors.append("Phase1 H2 grammar")
        if re.findall(r"^### (D\d): (.+)$", a, re.M) != expected:
            errors.append("Phase1 eligible dimension headings")
        if not a.strip().endswith("[CONTRACT-ACKNOWLEDGED]") or "criteria_binding_unavailable" not in a:
            errors.append("Phase1 binding/terminal acknowledgement")
        if re.findall(r"^contract_role: (.+)$", b, re.M) != [role]:
            errors.append("Phase2 role binding")
        if "## Failure Condition Checks" in b or "## Editorial Decision" in b or re.search(r"^editorial_decision=", b, re.M):
            errors.append("Per-seat decision prohibited")
        if "## Dimension Scores" not in b or "## Review Body" not in b:
            errors.append("Phase2 required headings")
            score_text = ""
        else:
            score_text = b.split("## Dimension Scores", 1)[1].split("## Review Body", 1)[0]
        actual = re.findall(r"^### (D\d): (.+)$", score_text, re.M)
        if actual != [(d["id"], d["name"]) for d in contract["acceptance_dimensions"]]:
            errors.append("Phase2 all dimensions required")
        votes = {}
        for d in contract["acceptance_dimensions"]:
            pat = r"^### " + re.escape(d["id"] + ": " + d["name"]) + r"\s*$([\s\S]*?)(?=^### |\Z)"
            m = re.search(pat, score_text, re.M)
            if not m:
                continue
            section = m.group(1)
            scores = re.findall(r"^score: (block|warn|pass|not_assessed)\s*$", section, re.M)
            if len(scores) != 1:
                errors.append(d["id"] + " score grammar")
                continue
            score = scores[0]
            votes[d["id"]] = score
            eligible = role in d["eligible_roles"]
            if not eligible and score != "not_assessed":
                errors.append(d["id"] + " out-of-role score")
            if score in ("warn", "block"):
                tm = re.search(r'^trigger: ["“](.+)["”]\s*$', section, re.M)
                phase1 = re.search(pat, a, re.M)
                key = "what_triggers_warn" if score == "warn" else "what_triggers_block"
                if "block_class: fatal" in section:
                    key = "what_triggers_fatal"
                trigger = re.search(r"^" + key + r": (.+)$", phase1.group(1), re.M) if phase1 else None
                if not tm or not trigger or tm.group(1) not in trigger.group(1):
                    errors.append(d["id"] + " trigger binding")
                if score == "block" and d["priority"] == "mandatory" and not re.search(r"^block_class: (fatal|repairable)\s*$", section, re.M):
                    errors.append(d["id"] + " block_class required")
        if role == "methodology" and "## Arithmetic Receipts" not in b:
            errors.append("Arithmetic receipt/attestation missing")
        if role == "da" and (b.count("#### CRITICAL") != 1 or b.count("#### MAJOR") != 1):
            errors.append("DA terminal tables")
        results.append({"role": role, "status": "PASS" if not errors else "FAIL", "errors": errors, "votes": votes})
    result = {"scope": "local structural subset only; not canonical conformance, target binding, calibration, or scholarly approval", "reports": results, "passed": all(x["status"] == "PASS" for x in results)}
    (HERE / "local-structure-results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
