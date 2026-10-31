# Platform-Centered Manuscript Revision Notes

Date: 2026-10-24

## Editorial objective

Present the submission as a reusable industrial-agent integration framework. Explain how the framework combines agent collaboration and strategy selection, production context, analysis services, and industrial communication through configurable workflows and interfaces. Describe execution governance as one operational service within that architecture rather than the paper's sole contribution.

## Changes made

- Revised the title and abstract to foreground the framework design, configurable integration, and multi-scene evaluation.
- Reordered the introduction, related work, system, mechanisms, evaluation, and discussion to establish the integration problem, introduce the framework and its modules, then assess adaptation across heterogeneous scenes and protocols.
- Retained the existing evidence and result values. Reworded the experiment narrative to distinguish demonstrated configuration reuse and interface operation from untested physical transfer or comparative performance claims.
- Updated Fig. 1's central module label to “Operational services” so the architecture represents the whole framework. Figures 2 and the result plots were not redrawn or altered.
- Kept the manuscript anonymized for double-blind review: the system design and functions remain described, while the product name is omitted from submission-facing text and metadata.

## Evidence boundaries retained

The evaluation uses simulator evidence, one trajectory per process scene, and a bounded deployment suite. The protocol results show controlled writable operation over four protocols; the RTU path is read-only. Q6 is a single accelerated recipe case, and the October 23 interface failures remain documented. The manuscript does not claim physical deployment transfer, general statistical superiority, or comparative optimization gains.

## Verification

- Abstract: one paragraph under 250 words, five keywords.
- IEEEtran two-column source compiled successfully; final PDF has 10 US-letter pages.
- Rendered and visually checked all 10 final PDF pages for clipping, figure legibility, and layout issues.
- Finalized source/evidence packages passed ZIP integrity and exact entry/hash comparison; package manifest records `zip_integrity: PASS` and `pages: 10`.
- Independent evidence and manuscript review: PASS with no P0–P2 findings. The ordering note raised as P3 was resolved by the evaluation narrative order and the note clarifying that archived Q labels are retained.

This is an internal editorial and technical review record, not a prediction or guarantee of IEEE TII acceptance.

## Workflow references

The figure-preparation workflow was informed by Kassis, T., Agarwal, V., He, Y., Patel, D., and Brueckner, A. M. (2026), “Scientific Agent Skills: A Library of Procedural Knowledge for Research Agents,” arXiv:2609.00065, current version v2, https://doi.org/10.48550/arXiv.2609.00065. This workflow citation is recorded here rather than in the TII manuscript because it does not support a technical claim about the industrial framework.
