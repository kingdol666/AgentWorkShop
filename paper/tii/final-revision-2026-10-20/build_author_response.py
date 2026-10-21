"""Local author response; does not change immutable review scores/roadmap."""
from pathlib import Path
import hashlib
import json

here = Path(__file__).resolve().parent
roadmap_path = here / 'review/REVISION-ROADMAP.json'
roadmap = json.loads(roadmap_path.read_text(encoding='utf-8'))
responses = [
    ('partially_addressed', 'Integration now names production-scoped authority, graded confirmation, and route-specific records; Related Work maps these to Q1/current tests, Q5, and Q4/Q6.', ['sections/introduction.tex', 'sections/related.tex'], 'Novelty is positioned without asserting each mechanism new; broader significance remains editorial judgement.'),
    ('residual_evidence_risk', 'The practical contribution is framed as inspectable authorization/evidence integration; no unmeasured superiority or incremental optimization benefit is claimed.', ['sections/related.tex', 'sections/discussion.tex'], 'No comparative experiment was added. Scholarly significance relative to neighbors remains a risk.'),
    ('bounded_disclosure_retained', 'Recorded-commit, current-inspection and missing exact historical dirty runtime states remain distinguished.', ['REPRODUCIBILITY.md', 'evidence/SOURCE-SNAPSHOT-STATUS.json', 'evidence/MISSING-EVIDENCE.json'], 'Exact historical executable worktree is unavailable; source snapshots are not represented as exact replay.'),
    ('bounded_disclosure_retained', 'Q6 covers the three observed quality quantities and explicitly allows absent melt temperature.', ['sections/evaluation.tex', 'REPRODUCIBILITY.md'], 'Complete critical-variable acceptance requires new evidence and is not claimed.'),
    ('bounded_disclosure_retained', 'Q6 states freshness uses the newest available timestamp rather than checking every sensor independently.', ['sections/evaluation.tex', 'REPRODUCIBILITY.md'], 'Individual-sensor freshness is not established.'),
    ('provenance_annotation_added', 'Plot uses /final; later /update rationale numbers are preserved separately with missing raw-sample linkage stated.', ['sections/evaluation.tex', 'REPRODUCIBILITY.md', 'evidence/R6-MEASUREMENT-NOTES.json'], 'No separate sample or timestamp is inferred; original raw fields remain unchanged.'),
    ('minimum_scope_remedy_implemented', 'Conclusion narrows accountability to traceable authorization and evidence attribution; operator comprehension and deployment responsibilities remain separate.', ['sections/discussion.tex', 'sections/mechanisms.tex'], 'No deployment incident/recovery matrix or validated operational responsibility claim is invented.'),
    ('first_page_qualification_added', 'Abstract explicitly says approvals were scripted; Q6 text/caption and scope distinguish workflow authorization from human-performance evidence.', ['main.tex', 'sections/evaluation.tex', 'sections/discussion.tex'], 'No human-subject performance result is claimed.'),
    ('first_page_qualification_retained', 'Abstract and first-page roadmap identify repository simulators/simulator-backed evidence.', ['main.tex', 'sections/introduction.tex', 'sections/evaluation.tex'], 'Production objects in experiments are modeled; physical transfer is not established.'),
    ('minimum_scope_remedy_implemented', 'Abstract limits conclusion to exercised routes; discussion explicitly says no current-version E2E study jointly changes strategy, protocol and context.', ['main.tex', 'sections/discussion.tex', 'sections/evaluation.tex'], 'Cross-route generalization would require new evidence; design integration is not pooled experimental proof.')
]
assert len(responses) == len(roadmap['items']) == 10
items = []
for source, response in zip(roadmap['items'], responses):
    status, action, anchors, residual = response
    items.append({'roadmap_item': source['id'], 'source_report': source['source_report'], 'source_finding': source['parent_finding'], 'source_subclaims': source['sub_claim_ids'], 'author_triage': 'will_address', 'authorization': 'user-approved implementation plan; no new experiments/runtime edits', 'implementation_status': status, 'action': action, 'anchors': anchors, 'residual': residual, 'reviewer_score_changed': False})
out = {'schema': 'local-author-response/1.0', 'canonical_status': 'unbound local sidecar; not canonical author-adjudication validation', 'roadmap_sha256': hashlib.sha256(roadmap_path.read_bytes()).hexdigest(), 'final_pdf_sha256': 'c4a8018c9e7c5b50eae592c1efecf1eb22634851116e330294a389fb5b6a976b', 'items': items, 'coverage': {'roadmap_items': 10, 'responses': len(items), 'missing': []}, 'note': 'A disclosure or scoped remedy does not recover missing data, upgrade original reviews, or establish journal acceptance.'}
(here / 'AUTHOR-RESPONSE.json').write_text(json.dumps(out, indent=2), encoding='utf-8')
print('PASS: all 10 immutable roadmap items have separate source-ordered author responses')
