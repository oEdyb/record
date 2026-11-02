from pathlib import Path
import json,subprocess,hashlib,numpy as np
r=Path('/home/olle/.local/state/agent-lab/klippt/profiles/electron/recordings')
proof=json.loads(Path('/tmp/klippt-cursor-packaged-final-state.json').read_text())
d=json.loads((r/f"recording-{proof['recordingId']}.session.json").read_text())
assert [c['cursorCaptureMode'] for c in d['clips']]==['system','editable-overlay']
proof['clips']=[]
for c in d['clips']:
 p=Path(c['screenVideoPath']);dec=subprocess.run(['ffmpeg','-v','error','-i',str(p),'-f','null','-'],capture_output=True,text=True);assert dec.returncode==0,dec.stderr
 raw=subprocess.run(['ffmpeg','-v','error','-i',str(p),'-vf','crop=80:80:380:480','-f','rawvideo','-pix_fmt','rgb24','-'],capture_output=True,check=True).stdout
 frames=np.frombuffer(raw,dtype=np.uint8).reshape(-1,80,80,3);whites=(frames>180).all(axis=-1).sum(axis=(1,2))
 row={**c,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'fullDecodeExit':dec.returncode,'frames':len(frames),'cursorRoiMaxWhitePixels':int(whites.max())}
 side=Path(str(p)+'.cursor.json')
 if c['cursorCaptureMode']=='editable-overlay':
  cur=json.loads(side.read_text());assert cur['assets'];assert cur['samples'];assert all(0<=s['timeMs']<=c['durationMs'] for s in cur['samples']);row['cursorSamples']=len(cur['samples']);row['cursorAssets']=len(cur['assets'])
 else: assert not side.exists()
 proof['clips'].append(row)
assert proof['clips'][0]['sha256']==proof['firstClipSha256AfterAcknowledgedPause']
assert proof['clips'][0]['cursorRoiMaxWhitePixels']>10
assert proof['clips'][1]['cursorRoiMaxWhitePixels']==0
proof['sourceCommit']='fcf6b7dd025d15ccabddf6d908b69b69ba2731d7';proof['normalFuseAppImage']=True;proof['sameHelperAfterReplacement']=True;proof['privateLab']='klippt';proof['allAssertionsPass']=True
app=Path('/home/olle/dev/screenrec-linux/release/linux-port-20261026-fcf6b7dd/Klippt-Linux-1.9.5.AppImage');proof['appImageSha256']=hashlib.sha256(app.read_bytes()).hexdigest()
out=Path('/home/olle/dev/screenrec-linux/artifacts/linux-port-2026-10-26/cursor-grant/packaged-verification.json');out.write_text(json.dumps(proof,indent=2)+'\n');print(json.dumps(proof,indent=2))
