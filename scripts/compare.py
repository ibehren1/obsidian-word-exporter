"""Side-by-side page images: Obsidian PDF (left) vs Word export (right).
Usage: python3 scripts/compare.py "test-output/Name" [dpi]"""
import subprocess, sys, glob, os
from PIL import Image, ImageDraw
base = sys.argv[1]
dpi = sys.argv[2] if len(sys.argv) > 2 else '80'
for kind in ('obsidian', 'word'):
    for f in glob.glob(f'{base}.{kind}-*.png'): os.remove(f)
    subprocess.run(['pdftoppm', '-r', dpi, '-png', f'{base}.{kind}.pdf', f'{base}.{kind}'], check=True)
def pages(kind):
    return sorted(glob.glob(f'{base}.{kind}-*.png'), key=lambda p: int(p.rsplit('-', 1)[1][:-4]))
a, b = pages('obsidian'), pages('word')
for i in range(max(len(a), len(b))):
    ims = [Image.open(x[i]) if i < len(x) else None for x in (a, b)]
    w = max(im.width for im in ims if im); h = max(im.height for im in ims if im)
    out = Image.new('RGB', (w * 2 + 12, h), (120, 120, 120))
    for j, im in enumerate(ims):
        if im: out.paste(im, (j * (w + 12), 0))
    out.save(f'{base}.cmp-{i+1}.png')
    print(f'{base}.cmp-{i+1}.png')
