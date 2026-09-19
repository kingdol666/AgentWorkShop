"""Move the wide AgentTeam-mission figure declaration earlier in evaluation.tex.

LaTeX can only place double-column floats at a page top or bottom, and a late
declaration leaves a large column gap on the page where it is deferred. Moving
the declaration next to the other results figure lets it be placed without that
gap. Figure numbering is preserved because the declaration order is unchanged.
"""
import pathlib

path = pathlib.Path(__file__).resolve().parent.parent / "sections" / "evaluation.tex"
lines = path.read_text(encoding="utf-8").splitlines(True)

start = next(i for i, l in enumerate(lines) if l.startswith("\\begin{figure*}"))
end = next(i for i, l in enumerate(lines) if i > start and l.startswith("\\end{figure*}"))
block = lines[start:end + 1]
rest = lines[:start] + lines[end + 1:]

anchor = next(i for i, l in enumerate(rest) if l.startswith("\\end{figure}"))
out = rest[:anchor + 1] + ["\n"] + block + rest[anchor + 1:]
path.write_text("".join(out), encoding="utf-8")
print(f"moved lines {start}-{end} to position {anchor}")
