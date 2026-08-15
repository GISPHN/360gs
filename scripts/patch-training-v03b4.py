from pathlib import Path

p = Path('training.js')
s = p.read_text(encoding='utf-8')
old = "const app=new mod.BrushApp();app.initExisting(ad,dev,dev.queue);"
new = "const app=new mod.BrushApp();trProgress(1.5,'BrushのGPU共有初期化を完了しています');await app.initExisting(ad,dev,dev.queue);"
if old not in s:
    raise SystemExit('initExisting pattern not found')
s = s.replace(old, new, 1)
s = s.replace('0.3b3', '0.3b4')
p.write_text(s, encoding='utf-8')

for name in ['video.html', 'index.html']:
    q = Path(name)
    t = q.read_text(encoding='utf-8').replace('0.3b3', '0.3b4')
    q.write_text(t, encoding='utf-8')
