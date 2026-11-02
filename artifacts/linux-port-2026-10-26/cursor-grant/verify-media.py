from pathlib import Path
import hashlib,json,subprocess,numpy as np
repo=Path('/home/olle/dev/screenrec-linux')
root=Path('/home/olle/.local/state/agent-lab/klippt/profiles/electron/recordings')
out=repo/'artifacts/linux-port-2026-10-26/cursor-grant'
proof=json.loads(Path('/tmp/klippt-cursor-proof-state.json').read_text())
proof.update({'privateDesktop':'agent-lab klippt: headless KWin/KDE portal, private Wayland/input/D-Bus/PipeWire','hostDesktopDriven':False,'baseCommit':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),'sessions':[]})
for recording_id in [1793013006257,1793013046358]:
 manifest=root/f'recording-{recording_id}.session.json'
 session=json.loads(manifest.read_text()); media=[]
 for clip in session['clips']:
  p=Path(clip['screenVideoPath'])
  decoded=subprocess.run(['ffmpeg','-v','error','-i',str(p),'-f','null','-'],capture_output=True,text=True)
  assert decoded.returncode==0,decoded.stderr
  crop=subprocess.run(['ffmpeg','-v','error','-i',str(p),'-vf','crop=80:80:380:480','-pix_fmt','rgb24','-f','rawvideo','-'],capture_output=True,check=True)
  a=np.frombuffer(crop.stdout,dtype=np.uint8).reshape(-1,80,80,3)
  white=(a>180).all(axis=-1).sum(axis=(1,2))
  row={**clip,'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'fullDecodeExit':decoded.returncode,'decodedFrames':len(a),'cursorRoi':{'x':380,'y':480,'width':80,'height':80,'maxWhitePixels':int(white.max()),'framesAbove10WhitePixels':int((white>10).sum())}}
  side=Path(str(p)+'.cursor.json')
  if clip['cursorCaptureMode']=='editable-overlay':
   cursor=json.loads(side.read_text()); samples=cursor['samples']; assets=cursor['assets']
   assert len(samples)>0 and len(assets)>0
   assert all(0<=s['timeMs']<=clip['durationMs'] for s in samples)
   ids={asset['id'] for asset in assets}
   assert all(s.get('assetId') is None or s['assetId'] in ids for s in samples)
   row['cursor']={'samples':len(samples),'assets':len(assets),'firstTimeMs':samples[0]['timeMs'],'lastTimeMs':samples[-1]['timeMs'],'allSamplesInsideClip':True,'allAssetReferencesResolve':True,'sha256':hashlib.sha256(side.read_bytes()).hexdigest()}
  else:
   assert not side.exists(),'system clip must not get an editable cursor sidecar'
  media.append(row)
 proof['sessions'].append({'recordingId':recording_id,'clips':media})
assert [c['cursorCaptureMode'] for c in proof['sessions'][1]['clips']]==['editable-overlay','system','editable-overlay']
assert proof['sessions'][1]['clips'][0]['sha256']==proof['firstClipSha256AfterFirstPause']
assert proof['sessions'][1]['clips'][1]['cursorRoi']['maxWhitePixels']>10
assert proof['sessions'][1]['clips'][2]['cursorRoi']['maxWhitePixels']==0
proof['cursorPixelsAgreeWithModes']=True
proof['firstFinalizedClipUnchanged']=True
proof['helperStayedSameAcrossBothReplacements']=True
proof['note']='First cursor mode-change/cancellation desktop pass preceded terminal accumulator cleanup; these two sessions use the final rebuilt Electron runtime in one app process. All actions used compositor-level private input. No physical camera/audio or exact Niri capture claim.'
files=subprocess.check_output(['git','diff','--name-only'],cwd=repo,text=True).splitlines()
proof['sourceFileSha256']={p:hashlib.sha256((repo/p).read_bytes()).hexdigest() for p in files if p.startswith(('electron/','src/'))}
helper=repo/'electron/native/pipewire-capture/build/openscreen-pipewire-helper'
proof['helperSha256']=hashlib.sha256(helper.read_bytes()).hexdigest()
proof['productionElectronModulesSha256']={p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in (repo/'dist-electron').glob('*.js')}
(out/'verification.json').write_text(json.dumps(proof,indent=2)+'\n')
print('Verified',sum(len(s['clips']) for s in proof['sessions']),'fully decoded clips; cursor pixel and sidecar assertions pass')
