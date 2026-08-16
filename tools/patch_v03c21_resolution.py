from pathlib import Path

p=Path('training.js')
s=p.read_text()
old="const shown=parseInt(document.querySelector('#dataset-size')?.textContent||'',10),size=[640,768,1024].includes(shown)?shown:768,erpW=size,erpH=Math.max(2,Math.round(size/2));"
new="const shown=parseInt(document.querySelector('#dataset-size')?.textContent||'',10),size=[640,768,1024].includes(shown)?shown:768,erpW=Math.min(2048,Math.max(1024,size*2)),erpH=Math.max(2,Math.round(erpW/2));"
if old not in s: raise RuntimeError('direct ERP source resolution target not found')
s=s.replace(old,new,1)
s=s.replace("res:Math.min(size,512),label:'高品質・direct ERP＋post-pose再調整'","res:Math.min(size,1536),label:'高品質・direct ERP＋post-pose再調整'",1)
s=s.replace("res:Math.min(size,512),label:'品質優先・direct ERP＋post-pose再調整'","res:Math.min(size,1024),label:'品質優先・direct ERP＋post-pose再調整'",1)
s=s.replace("res:Math.min(size,384),label:'省メモリ・direct ERP＋post-pose再調整'","res:Math.min(size,768),label:'省メモリ・direct ERP＋post-pose再調整'",1)
p.write_text(s)

p=Path('BUILD_VERSION.txt')
s=p.read_text()
marker='Tiny polar caps are excluded from rasterization where longitude is mathematically singular; their spherical area weight is near zero\n'
if marker not in s: raise RuntimeError('BUILD_VERSION c21 marker not found')
s=s.replace(marker,marker+'ERP source width is 1024-2048 px and Brush uses an adaptive 768/1024/1536 px long-edge cap so direct ERP is not unfairly downsampled against the former 512 px per-face cubemap\n',1)
p.write_text(s)
