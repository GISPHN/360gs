from pathlib import Path
for name in ['training.js','video.html','index.html']:
    p=Path(name)
    if not p.exists():
        continue
    s=p.read_text(encoding='utf-8')
    s=s.replace('0.3b4','0.3b5')
    p.write_text(s,encoding='utf-8')
