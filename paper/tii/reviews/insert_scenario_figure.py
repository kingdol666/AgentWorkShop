"""Rewrite the Scripted Team Missions subsection around the new scenario figure.

Inserts the fig11 float, adds the smooth lead-in that names what the reader is
about to see, and keeps every boundary claim that the blind review required.
"""
import pathlib

path = pathlib.Path(__file__).resolve().parent.parent / "sections" / "evaluation.tex"
text = path.read_text(encoding="utf-8")

LEAD_OLD = """The second mission is the more demanding one. The biaxial-film preset is
provisioned as one full line with nine devices, 30 writable setpoints, 19
configured acquisition nodes, and driver tests passing on all nine devices; all
nine were created by the benchmark's own probe-and-provision step, so this layer
measures provisioning and governance rather than commissioning a line that
already existed. The scripted team files a thickness objective of
$25.0\\pm0.7\\,\\mu$m, accepted as $|h-25.0|\\leq0.7\\,\\mu$m. The initial gauge
reading, taken through the real MQTT path, is 28.10\\,$\\mu$m, outside the window.
The worker then applies three governed actions:"""

LEAD_NEW = """The second mission is the more demanding one, and Fig.~\\ref{fig:agentteam} maps
it end to end: the simulated line with its actuators and gauge, the team that
files the objective, the four admission checks every request must clear, the three
steps the run recorded, and the thickness response they produced. The
biaxial-film preset is provisioned as one full line with nine devices, 30 writable
setpoints, 19 configured acquisition nodes, and driver tests passing on all nine;
all nine were created by the benchmark's own probe-and-provision step, so this
layer measures provisioning and governance rather than commissioning a line that
already existed. The scripted team files a thickness objective of
$25.0\\pm0.7\\,\\mu$m, accepted as $|h-25.0|\\leq0.7\\,\\mu$m. The initial gauge
reading, taken through the real MQTT path, is 28.10\\,$\\mu$m, outside the window.
The worker then applies three governed actions, tabulated in the figure:"""

FIGURE = """
\\begin{figure*}[!tb]
\\centering
\\includegraphics[width=0.82\\textwidth]{figures/publication/fig11-agentteam-loop.pdf}
\\caption{Scripted AgentTeam mission in archive $B$, reconstructed from
\\texttt{agentteam-biax.log} and \\texttt{run.json}. Top: the simulated BOPET line
whose nine devices, 30 setpoints, and 19 acquisition nodes the benchmark
provisions, with the three written actuators, the gauge that supplies thickness,
and the objective filed against them. Middle: the channel that carries the
objective, the four admission checks each request clears before any driver is
invoked, and the three steps the run recorded. Bottom: measured thickness after
each step against the $25.0\\pm0.7\\,\\mu$m objective, and the outcome; the final
point clears the band edge by $0.02\\,\\mu$m. Team members are scripted mock agents,
the setpoints come from a prespecified proportional rule, and the LLM agent is
disabled, so the figure documents the governance and attribution path rather than
an LLM's optimization quality. The melt-temperature window is a simulator
feasibility bound that these three actuators do not drive. The HTML source of this
figure carries the same process as a step-by-step animation; the published frame is
the complete static state.}
\\label{fig:agentteam}
\\end{figure*}

\\begin{enumerate}"""

ANALYSIS_OLD = """Each action is a separate governed write to a different line section, and the
three span two protocols and two engineering units rather than three of each.
Every write passed the binding, range, and recipe-window checks, was accepted by
its driver, opened its own optimization record, and was followed by a gauge
re-read after a settling wait. Only those parts are recorded: the archive stores
no post-write readback value for these three writes, so we claim none. The
verdicts are not an independent finding either, since the scripted caller issues
\\texttt{keep} unconditionally; the records show that judgment is stored separately
from execution and compensation, not that a judgment was earned. Ledger
attribution was queried on the cast-speed node and returned the record with an
agent source. The final thickness is 25.68\\,$\\mu$m, satisfying
$|h-25.0|=0.68\\leq0.7\\,\\mu$m by $0.02\\,\\mu$m on a short bucket mean, and the
mission closes with 3 of its 6 allowed writes used. Melt temperature stays near
$291.5\\,^\\circ$C inside its 268--300\\,$^\\circ$C process window, which is an
observation rather than an enforcement result: the window is the simulator's own
feasibility bound, none of the three written actuators drives melt temperature in
the plant model, and no disturbance tested it."""

ANALYSIS_NEW = """Each action is a separate governed write to a different line section, and the
three span two protocols and two engineering units rather than three of each.
Every write cleared the gate shown in the figure, was accepted by its driver,
opened its own optimization record, and was followed by a gauge re-read after a
settling wait. Only those parts are recorded: the archive stores no post-write
readback value for these three writes, so we claim none. The verdicts are not an
independent finding either, since the scripted caller issues \\texttt{keep}
unconditionally; the records show that judgment is stored separately from
execution and compensation, not that a judgment was earned. Ledger attribution was
queried on the cast-speed node and returned the record with an agent source.

The final thickness is 25.68\\,$\\mu$m, satisfying $|h-25.0|=0.68\\leq0.7\\,\\mu$m
by $0.02\\,\\mu$m on a short bucket mean, and the mission closes with 3 of its 6
allowed writes used. Melt temperature stays near $291.5\\,^\\circ$C inside its
268--300\\,$^\\circ$C process window, which is an observation rather than an
enforcement result: the window is the simulator's own feasibility bound, none of
the three written actuators drives melt temperature in the plant model, and no
disturbance tested it."""

for old, new, tag in ((LEAD_OLD, LEAD_NEW, "lead-in"), (ANALYSIS_OLD, ANALYSIS_NEW, "analysis")):
    assert old in text, f"missing block: {tag}"
    text = text.replace(old, new, 1)

# Drop the superseded float and its stray blank line, then attach the new float
# to the paragraph that now refers to it.
start = text.index("\\begin{figure*}[!tb]")
end = text.index("\\end{figure*}", start) + len("\\end{figure*}\n")
text = text[:start] + text[end:]
text = text.replace("\n\n\nTwo readings", "\n\nTwo readings")

anchor = "The worker then applies three governed actions, tabulated in the figure:"
text = text.replace(anchor, anchor + "\n" + FIGURE, 1)

path.write_text(text, encoding="utf-8")
print("evaluation.tex updated")
