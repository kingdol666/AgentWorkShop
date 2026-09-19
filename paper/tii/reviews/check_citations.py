import re
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
tex_files = list((root / "sections").glob("*.tex")) + [root / "main.tex"]
tex = "\n".join(f.read_text(encoding="utf-8") for f in tex_files)

cited = set()
for match in re.finditer(r"\\cite\{([^}]*)\}", tex):
    for key in match.group(1).split(","):
        cited.add(key.strip())

bib = (root / "refs.bib").read_text(encoding="utf-8")
keys = set(re.findall(r"@\w+\{([^,]+),", bib))

print("cited:", len(cited), "bib keys:", len(keys))
print("cited but missing from bib:", sorted(cited - keys))
print("in bib but never cited:", sorted(keys - cited))
nums = sorted(len(k) for k in cited)
print("citation key count sanity:", len(cited))
