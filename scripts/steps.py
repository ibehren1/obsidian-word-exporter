"""Local layout accuracy: for consecutive text lines matched between the
Obsidian PDF and the Word PDF that sit on the same page in both, how much
their vertical gap differs (points). Page-break shifts don't count.
Usage: python3 scripts/steps.py "test-output/Name" [--worst N]"""
import subprocess, sys, re, html
from difflib import SequenceMatcher

def lines(pdf):
    out = subprocess.run(['pdftotext', '-bbox-layout', pdf, '-'], capture_output=True, text=True).stdout
    res = []
    for pi, page in enumerate(re.findall(r'<page.*?</page>', out, re.S)):
        for m in re.findall(r'<line xMin="([\d.]+)" yMin="([\d.]+)" xMax="[\d.]+" yMax="[\d.]+">(.*?)</line>', page, re.S):
            text = ' '.join(html.unescape(w) for w in re.findall(r'>([^<]+)</word>', m[2])).strip()
            if text: res.append((pi + 1, float(m[1]), text))
    return res

base = sys.argv[1]
a, b = lines(f'{base}.obsidian.pdf'), lines(f'{base}.word.pdf')
norm = lambda t: re.sub(r'^[•¨þ☐☑]\s*', '', t)
sm = SequenceMatcher(None, [norm(x[2]) for x in a], [norm(x[2]) for x in b], autojunk=False)
pairs = [(a[i], b[j]) for tag, i1, i2, j1, j2 in sm.get_opcodes() if tag == 'equal' for i, j in zip(range(i1, i2), range(j1, j2))]
steps = []
for (a1, b1), (a2, b2) in zip(pairs, pairs[1:]):
    if a1[0] == a2[0] and b1[0] == b2[0] and a2[1] > a1[1]:
        steps.append((abs((b2[1] - b1[1]) - (a2[1] - a1[1])), a2[2]))
n = len(steps)
ok = sum(1 for s, _ in steps if s <= 1.0)
print(f"steps={n} within1pt={100 * ok // max(n, 1)}% max={max((s for s, _ in steps), default=0):.1f}")
if '--worst' in sys.argv:
    for s, t in sorted(steps, reverse=True)[: int(sys.argv[sys.argv.index('--worst') + 1])]:
        print(f"  {s:5.1f}  {t[:70]}")
