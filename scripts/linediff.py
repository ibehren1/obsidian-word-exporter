"""Compares text line positions between Obsidian's PDF and the Word PDF.
Lines are matched by text; prints page/x/y for each and the deltas in points.
Usage: python3 scripts/linediff.py "test-output/Name" """
import subprocess, sys, re, html
from difflib import SequenceMatcher
base = sys.argv[1]

def lines(pdf):
    out = subprocess.run(['pdftotext', '-bbox-layout', pdf, '-'], capture_output=True, text=True).stdout
    res = []
    for page_i, page in enumerate(re.findall(r'<page.*?</page>', out, re.S)):
        for line in re.findall(r'<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</line>', page, re.S):
            words = [html.unescape(w) for w in re.findall(r'>([^<]+)</word>', line[4])]
            text = ' '.join(words).strip()
            if text:
                res.append((page_i + 1, float(line[0]), float(line[1]), float(line[3]), text))
    return res

a = lines(f'{base}.obsidian.pdf')
b = lines(f'{base}.word.pdf')
sm = SequenceMatcher(None, [x[4] for x in a], [x[4] for x in b], autojunk=False)
print(f"{'text':40} {'obs p/x/y':>18} {'word p/x/y':>18} {'dx':>6} {'dy':>6}")
for tag, i1, i2, j1, j2 in sm.get_opcodes():
    if tag == 'equal':
        for i, j in zip(range(i1, i2), range(j1, j2)):
            A, B = a[i], b[j]
            print(f"{A[4][:40]:40} {A[0]:>3}/{A[1]:6.1f}/{A[2]:6.1f} {B[0]:>3}/{B[1]:6.1f}/{B[2]:6.1f} {B[1]-A[1]:6.1f} {B[2]-A[2] if A[0]==B[0] else float('nan'):6.1f}")
    else:
        for i in range(i1, i2): print(f"  OBS ONLY: p{a[i][0]} y{a[i][2]:.1f} {a[i][4][:70]}")
        for j in range(j1, j2): print(f"  WORD ONLY: p{b[j][0]} y{b[j][2]:.1f} {b[j][4][:70]}")
