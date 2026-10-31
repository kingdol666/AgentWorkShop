from PIL import Image, ImageDraw
from pathlib import Path
files = sorted(Path('qa/expert-review-2026-10-27/pages').glob('page-*.png'))
thumb_w, thumb_h = 350, 453
cell_w, cell_h = thumb_w + 12, thumb_h + 36
sheet = Image.new('RGB', (5 * cell_w, 2 * cell_h), (225, 225, 225))
for index, path in enumerate(files):
    image = Image.open(path).convert('RGB')
    image.thumbnail((thumb_w, thumb_h))
    tile = Image.new('RGB', (cell_w, cell_h), 'white')
    tile.paste(image, ((cell_w-image.width)//2, 4))
    ImageDraw.Draw(tile).text((7, thumb_h+10), path.stem, fill='black')
    sheet.paste(tile, ((index % 5) * cell_w, (index // 5) * cell_h))
sheet.save('qa/expert-review-2026-10-27/contact-sheet.png')
print(f'Rendered {len(files)} pages to contact sheet')
