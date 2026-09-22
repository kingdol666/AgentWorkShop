import os, re
for f in sorted(os.listdir("design-demos")):
    if not f.endswith(".svg"):
        continue
    t = open(os.path.join("design-demos", f), encoding="utf-8").read()
    sizes = sorted({float(x) for x in re.findall(r'font-size="([\d.]+)"', t)})
    print(f"{f:22s} sizes(u)={sizes}")
    print(f"{'':22s} min {sizes[0]}u = {sizes[0]*0.72:.1f}pt, max {sizes[-1]}u = "
          f"{sizes[-1]*0.72:.1f}pt, distinct={len(sizes)}")
