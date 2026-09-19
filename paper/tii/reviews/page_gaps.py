import fitz

doc = fitz.open("main.pdf")
for index, page in enumerate(doc):
    blocks = page.get_text("blocks")
    for label, lo, hi in (("L", 0, 300), ("R", 300, 600)):
        ys = sorted(
            (b[1], b[3]) for b in blocks if lo <= b[0] < hi and b[3] > 40
        )
        if not ys:
            continue
        gaps = []
        prev = ys[0][1]
        for top, bottom in ys:
            if top - prev > 20:
                gaps.append((round(prev), round(top), round(top - prev)))
            prev = max(prev, bottom)
        if gaps:
            print("page %2d %s gaps: %s" % (index + 1, label, gaps))
