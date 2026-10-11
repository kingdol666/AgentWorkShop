# -*- coding: utf-8 -*-
"""One-shot compression patches for the review round (batch 2)."""
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new, 1)
            print("OK  ", path, "|", old[:52].replace("\n", " "))
        else:
            print("MISS", path, "|", old[:52].replace("\n", " "))
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)

patch('sections/mechanisms.tex', [
    (r"""every step is journaled with actor attribution. The box labeled
``Governance Agent'' denotes these deterministic platform stages of
Section~\ref{sec:mech}---not a model-bearing agent---and the judge annotation
denotes the caller's verdict-tool invocation.}""",
     r"""every step is journaled with actor attribution. The box labeled
``Governance Agent'' denotes these deterministic platform stages, not a
model-bearing agent; the judge annotation is the caller's verdict-tool
invocation.}"""),
    (r"""The pending request shows member, node, value, interval, and expiry---in the
deployed benchmark with the proposer's reasoning and per-parameter basis
(Fig.~\ref{fig:hitl}b). The
machine-checked fields are structured data; the proposer's free-text reasoning
is display-only and confers no authority.""",
     r"""The pending request shows member, node, value, interval, and expiry---in the
deployed benchmark, plus the proposer's reasoning and per-parameter basis
(Fig.~\ref{fig:hitl}b): machine-checked fields are structured data, the
free-text reasoning display-only and non-authoritative."""),
])

patch('sections/system.tex', [
    (r"\includegraphics[width=0.92\textwidth]{resources/fig2-architecture.pdf}",
     r"\includegraphics[width=0.88\textwidth]{resources/fig2-architecture.pdf}"),
])

patch('main.tex', [
    (r"""\begingroup
\scriptsize
\def\IEEEbibitemsep{0.2pt plus .4pt}""",
     r"""\begingroup
\linespread{0.93}\scriptsize
\def\IEEEbibitemsep{0.2pt plus .4pt}"""),
])
print("done")
