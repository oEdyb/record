import subprocess,pathlib,sys
root=pathlib.Path(sys.argv[2]).expanduser()
for variant in ['before', 'after']:
 (root/variant).mkdir(parents=True, exist_ok=True)
def run(args): return subprocess.run(args,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
if sys.argv[1]=='generate':
 for label,w,h in [('1080',1920,1080),('1440',2560,1440)]:
  # Static terminal-like rows alongside high-frequency edges, identical for each variant.
  vf="drawgrid=w=37:h=29:t=1:c=gray,drawtext=fontfile=/usr/share/fonts/TTF/DejaVuSansMono.ttf:text='const exportFrame = sourcePixels.map(render); 0123456789':fontsize=18:fontcolor=white:x=100:y=100,drawtext=fontfile=/usr/share/fonts/TTF/DejaVuSansMono.ttf:text='Native export quality / fine strokes / padding 50':fontsize=14:fontcolor=white:x=100:y=140"
  run(['ffmpeg','-y','-v','error','-f','lavfi','-i',f'color=c=0x202020:s={w}x{h}:r=30:d=0.4','-vf',vf,'-c:v','libx264','-qp','0','-preset','ultrafast',str(root/'before'/f'{label}.mp4')])
  (root/'after'/f'{label}.mp4').write_bytes((root/'before'/f'{label}.mp4').read_bytes())
else:
 for variant in ['before','after']:
  for case in ['1080-pad0','1080-pad50','1440-pad50']:
   d=root/variant; inp=d/('1440.mp4' if case.startswith('1440') else '1080.mp4')
   scale='null' if case.endswith('pad0') else 'scale=1536:864:flags=lanczos'
   crop='null' if case.endswith('pad0') else 'crop=1536:864:192:108'
   r=run(['ffmpeg','-v','info','-i',str(inp),'-i',str(d/f'{case}.mp4'),'-filter_complex',f'[0:v]{scale},format=yuv420p,extractplanes=y[ref];[1:v]{crop},extractplanes=y[out];[out][ref]psnr','-frames:v','1','-f','null','-'])
   print(variant,case,r.stderr.decode().split('PSNR')[-1].strip())
