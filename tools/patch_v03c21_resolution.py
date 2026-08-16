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
old_mask="""  const x=c.getContext('2d');if(!x)throw new Error('ERP球面重みmaskを作成できません。');
  const im=x.createImageData(w,h),d=im.data,seamFrac=.045;
  const smooth=t=>{t=Math.max(0,Math.min(1,t));return t*t*(3-2*t);};
  for(let yy=0;yy<h;yy++){
    const lat=((yy+.5)/h-.5)*Math.PI,area=Math.max(0,Math.cos(lat));
    for(let xx=0;xx<w;xx++){
      const edge=Math.min(xx+.5,w-xx-.5)/w,seam=smooth(edge/seamFrac),weight=Math.max(0,Math.min(1,area*seam));
      const i=(yy*w+xx)*4;d[i]=255;d[i+1]=255;d[i+2]=255;d[i+3]=Math.round(weight*255);
    }
  }
"""
new_mask="""  const x=c.getContext('2d');if(!x)throw new Error('ERP球面重みmaskを作成できません。');
  const im=x.createImageData(w,h),d=im.data;
  // Complementary longitude weights: the native view uses
  // .5*(1+cos(lon)); the 180-degree rolled view sees lon+pi and therefore
  // contributes .5*(1-cos(lon)). Their sum is exactly one. Multiplying both
  // by cos(latitude) yields an unbiased spherical-area weight while every
  // longitude seam is supervised strongly by the other view.
  for(let yy=0;yy<h;yy++){
    const lat=((yy+.5)/h-.5)*Math.PI,area=Math.max(0,Math.cos(lat));
    for(let xx=0;xx<w;xx++){
      const lon=((xx+.5)/w-.5)*Math.PI*2,seam=.5*(1+Math.cos(lon)),weight=Math.max(0,Math.min(1,area*seam));
      const i=(yy*w+xx)*4;d[i]=255;d[i+1]=255;d[i+2]=255;d[i+3]=Math.round(weight*255);
    }
  }
"""
if old_mask not in s: raise RuntimeError('ERP mask implementation target not found')
s=s.replace(old_mask,new_mask,1)
p.write_text(s)

p=Path('BUILD_VERSION.txt')
s=p.read_text()
marker='Tiny polar caps are excluded from rasterization where longitude is mathematically singular; their spherical area weight is near zero\n'
if marker not in s: raise RuntimeError('BUILD_VERSION c21 marker not found')
s=s.replace(marker,marker+'ERP source width is 1024-2048 px and Brush uses an adaptive 768/1024/1536 px long-edge cap so direct ERP is not unfairly downsampled against the former 512 px per-face cubemap\nComplementary seam weights sum exactly to cos(latitude) across the native and 180-degree ERP pair, preventing longitude-dependent double weighting\n',1)
p.write_text(s)
