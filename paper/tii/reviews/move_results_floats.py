"""Move both results floats to the front of section V so LaTeX can place them
without leaving the column gaps that a late declaration causes.

Declaration order -- and therefore figure numbering -- is preserved: the
single-column benchmark plot stays first, the wide scenario figure second.
"""
import pathlib
import re

path = pathlib.Path(__file__).resolve().parent.parent / "sections" / "evaluation.tex"
text = path.read_text(encoding="utf-8")


def cut(pattern: str) -> str:
    match = re.search(pattern, text, re.S)
    assert match, pattern
    return match.group(0)


wide = cut(r"\\begin\{figure\*\}\[!tb\].*?\\end\{figure\*\}\n")
single = cut(r"\\begin\{figure\}\[!t\]\n\\centering\n"
             r"\\includegraphics\[width=\\columnwidth\]\{figures/publication/"
             r"fig9-latest-benchmark\.pdf\}.*?\\end\{figure\}\n")

for block in (wide, single):
    text = text.replace(block, "", 1)

anchor = "\\subsection{Protocol Integration and Governed Writes}"
assert anchor in text
text = text.replace(anchor, single + "\n" + wide + "\n" + anchor, 1)
text = re.sub(r"\n{4,}", "\n\n", text)

path.write_text(text, encoding="utf-8")
print("floats moved; figure order preserved")
