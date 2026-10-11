# -*- coding: utf-8 -*-
"""Batch 8: final 50pt."""
import io

def rep(path, old, new):
    s = io.open(path, encoding='utf-8').read()
    if old in s:
        io.open(path, 'w', encoding='utf-8', newline='\n').write(s.replace(old, new, 1))
        print('OK ', path, '|', old[:46].replace("\n", ' '))
    else:
        print('MISS', path, '|', old[:46].replace("\n", ' '))

rep('main.tex',
    r"""Team identities reach semantic
data-acquisition (DAQ) and write-control (DCW) nodes through explicit
capabilities under a line-level fail-safe master switch;""",
    r"""Team identities reach semantic
data-acquisition (DAQ) and write-control (DCW) nodes through explicit
capabilities under a fail-safe line master switch;""")
rep('main.tex',
    r"""The evaluation exercises this single governed path through protocol-closure""",
    r"""The evaluation exercises this path through protocol-closure""")
rep('sections/evaluation.tex',
    r"""\looseness=-1 On the five protocol lines the suite stores \resDaqSamples{} DAQ samples through
real drivers, and governed writes are
accepted and read back on Modbus TCP, OPC~UA, MQTT, and HTTP (medians
47.8/19.8/19.3/32.9\,ms; the Modbus RTU-over-TCP satellite is
acquisition-only).""",
    r"""\looseness=-1 On the five protocol lines the suite stores \resDaqSamples{} DAQ samples
through real drivers and reads governed writes back on Modbus TCP, OPC~UA,
MQTT, and HTTP (medians 47.8/19.8/19.3/32.9\,ms; the RTU-over-TCP satellite
is acquisition-only).""")
rep('sections/evaluation.tex',
    r"""\resAnnealWall; BOPET's was not archived) are simulator
wall time under accelerated dynamics.""",
    r"""\resAnnealWall; BOPET's unarchived) are simulator
wall time under accelerated dynamics.""")
rep('sections/evaluation.tex',
    r"""\resBindingsLive{} member--node bindings; the running lines are simulator-
and bench-backed objects, not physical plants; \emph{multi-tenant} means
many provisioned lines and channels on one instance.""",
    r"""\resBindingsLive{} member--node bindings---simulator- and bench-backed
objects, not physical plants; \emph{multi-tenant} means many provisioned
lines and channels on one host.""")
rep('sections/related.tex',
    r"""Multi-agent frameworks coordinate tasks and tools, and
the Model Context Protocol
(MCP) and Agent-to-Agent (A2A) specifications standardize tool and inter-agent
interfaces \cite{mcp2024,a2a2025}; the tool they expose, however, is a bare
function signature carrying no line, product, or recipe context, with no
record separating admission from execution.""",
    r"""Multi-agent frameworks coordinate tasks and tools, and the Model Context
Protocol (MCP) and Agent-to-Agent (A2A) specifications standardize tool and
inter-agent interfaces \cite{mcp2024,a2a2025}; the tool they expose, however,
is a bare function signature carrying no line, product, or recipe context,
with no record separating admission from execution.""")
rep('sections/discussion.tex',
    r"""fixed, so counts are re-derivable rather than trusted; Q5 adds per-run
ledgers and event timelines.""",
    r"""fixed, so counts are re-derivable rather than trusted; Q5 adds per-run
ledgers and timelines.""")
print('done')
