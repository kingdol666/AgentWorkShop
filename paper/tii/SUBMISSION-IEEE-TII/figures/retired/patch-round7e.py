# -*- coding: utf-8 -*-
"""Batch 6: last ~180pt."""
import io

def patch(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new in pairs:
        if old in s:
            s = s.replace(old, new, 1)
            print("OK  ", path, "|", old[:48].replace("\n", " "))
        else:
            print("MISS", path, "|", old[:48].replace("\n", " "))
    io.open(path, 'w', encoding='utf-8', newline='\n').write(s)

patch('sections/discussion.tex', [
    (r"""In production, bindings govern
sanctioned tools, not arbitrary privileged-engine I/O, so least privilege,
endpoint security, and IT/OT separation remain necessary
\cite{iec62443-3-3,nist80082}; \system{} is neither a safety
instrumented function nor a plant-protection substitute \cite{iec61511};
and line-scoped approver authorization is still missing, so production
deployment needs segregation of duties and alarm-path failure tests
\cite{eemua191}.""",
     r"""In production, bindings govern
sanctioned tools, not arbitrary privileged-engine I/O---least privilege,
endpoint security, and IT/OT separation remain necessary
\cite{iec62443-3-3,nist80082}; \system{} is neither a safety
instrumented function nor a plant-protection substitute \cite{iec61511};
line-scoped approver authorization is still missing, so production needs
segregation of duties and alarm-path failure tests \cite{eemua191}."""),
])

patch('sections/mechanisms.tex', [
    (r"""(b)~The structured approval card raised on a manual binding (live system,
English gloss added): machine-checkable fields are separated from the
proposer's free-text reasoning, which is display-only and confers no
authority; the adjudication comment returns to the proposing member on
refusal (Section~\ref{sec:hitl}).}""",
     r"""(b)~The structured approval card on a manual binding (live system, gloss
added): machine-checkable fields are separated from the proposer's
display-only reasoning; the comment returns to the member on refusal
(Section~\ref{sec:hitl}).}"""),
    (r"""A line can instead be placed in \emph{hold} mode,
in which an unanswerable request persists---no expiry, periodic reminders to
the line's operate-scoped users---until a human answers; a repeat governed
request for the held node is refused as a duplicate, and other nodes proceed
under their own policy.""",
     r"""In \emph{hold} mode an unanswerable request persists---no expiry, periodic
reminders to the line's operate-scoped users---until a human answers; a
repeat governed request for the held node is refused as a duplicate, and
other nodes proceed under their own policy."""),
])

patch('sections/evaluation.tex', [
    (r"""deployment-scale regression with write-evidence verification (Q5). Q1 exercises the
integration boundary and attributes the admission gate; Q2--Q4 occupy the
strategy slot (scripted policies, with two live engine turns in Q2); Q5
stresses the hardened platform under load.""",
     r"""deployment-scale regression with write-evidence verification (Q5); Q2--Q4
occupy the strategy slot (scripted policies, two live engine turns in Q2),
and Q5 stresses the hardened platform under load."""),
    (r"""Annealing starts far outside the hardness window
(\resAnnealStart\,HV on the Vickers scale at 140\,m/min); zone-3 temperature, one zone-2 trim, and two""",
     r"""Annealing starts far outside the hardness window
(\resAnnealStart\,HV, Vickers, at 140\,m/min); zone-3 temperature, one
zone-2 trim, and two"""),
    (r"""(round-trip latency \resHitlLatency{} from card raised to dispatch complete,
harness-adjudicated and dominated by the harness's decision poll; Q5 reports
the server-side approval-to-dispatch span alone).""",
     r"""(round-trip latency \resHitlLatency{} from card raised to dispatch
complete, harness-adjudicated, dominated by the harness's decision poll; Q5
reports the server-side span alone)."""),
])

patch('sections/system.tex', [
    (r"""the acknowledgment grade and,
where supported, the readback close the command path; the parameter journal
attributes the change to its source; and
attainment is computed against the scenario predicate while the task closes with
a workflow terminal state (the per-intervention view follows in
Section~\ref{sec:mech}).""",
     r"""the acknowledgment grade and,
where supported, the readback close the command path; the journal attributes
the change; and attainment is computed against the scenario predicate while
the task closes with a workflow terminal state (per-intervention detail in
Section~\ref{sec:mech})."""),
    (r"\renewcommand{\arraystretch}{1.05}",
     r"\renewcommand{\arraystretch}{1.0}"),
])

patch('sections/system.tex', [
    (r"\includegraphics[width=0.88\textwidth]{resources/fig2-architecture.pdf}",
     r"\includegraphics[width=0.84\textwidth]{resources/fig2-architecture.pdf}"),
])
patch('sections/mechanisms.tex', [
    (r"\includegraphics[width=0.6\textwidth]{resources/aws_fig3-flat.png}",
     r"\includegraphics[width=0.58\textwidth]{resources/aws_fig3-flat.png}"),
])
patch('main.tex', [
    (r"\enlargethispage{11\baselineskip}",
     r"\enlargethispage{12\baselineskip}"),
])
print("done")
