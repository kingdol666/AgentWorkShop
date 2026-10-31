from PIL import Image, ImageDraw
from pathlib import Path
folder = Path('qa/final-review-2026-10-26-final')
files = sorted(folder.glob('page-*.png'))
thumb_w, margin, label_h, cols = 360, 18, 28, 3
thumbs = []
for i, path in enumerate(files, 1):
    im = Image.open(path).convert('RGB')
    h = round(im.height * thumb_w / im.width)
    im = im.resize((thumb_w, h))
    tile = Image.new('RGB', (thumb_w, h + label_h), 'white')
    tile.paste(im, (0, label_h))
    ImageDraw.Draw(tile).text((8, 7), f'Page {i}', fill='black')
    thumbs.append(tile)
rows = (len(thumbs) + cols - 1) // cols
cell_h = max(t.height for t in thumbs)
sheet = Image.new('RGB', (cols * thumb_w + (cols+1)*margin, rows * cell_h + (rows+1)*margin), '#d8dce2')
for idx, tile in enumerate(thumbs):
    x = margin + (idx % cols) * (thumb_w + margin)
    y = margin + (idx // cols) * (cell_h + margin)
    sheet.paste(tile, (x, y))
sheet.save(folder / 'contact.png')
