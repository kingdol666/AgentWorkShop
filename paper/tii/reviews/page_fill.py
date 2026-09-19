import fitz

doc = fitz.open("main.pdf")
for index, page in enumerate(doc):
    blocks = page.get_text("blocks")
    if not blocks:
        print(index + 1, "EMPTY")
        continue
    cols = {}
    for block in blocks:
        key = "L" if block[0] < 300 else "R"
        cols[key] = max(cols.get(key, 0.0), block[3])
    left = cols.get("L", 0.0)
    right = cols.get("R", 0.0)
    print("page %2d  L_bottom=%6.1f  R_bottom=%6.1f" % (index + 1, left, right))
