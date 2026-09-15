#!/bin/bash
# Convert SVG figure HTML wrappers to exact-size PDFs via headless Chrome.
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="$DIR/../pdf"
mkdir -p "$OUT"
for name in "$@"; do
  "$CHROME" --headless=new --disable-gpu --no-pdf-header-footer \
    --print-to-pdf="$OUT/$name.pdf" \
    "file:///D:/codes/ABO/AgentWorkShop/paper/tii/figures/svg/$name.html" 2>/dev/null
  echo "== $name.pdf: $(pdfinfo "$OUT/$name.pdf" 2>/dev/null | grep 'Page size')"
done
