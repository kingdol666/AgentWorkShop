import re
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent
tex = (root / "main.tex").read_text(encoding="utf-8")
match = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", tex, re.S)
body = match.group(1)
body = re.sub(r"\\[a-zA-Z]+\*?(\[[^\]]*\])?(\{[^}]*\})?", " ", body)
body = body.replace("~", " ").replace("{", " ").replace("}", " ")
body = body.replace("\\", " ").replace("$", " ")
words = [w for w in re.split(r"\s+", body) if w.strip()]
print("abstract words:", len(words))
print("body:", " ".join(words))
