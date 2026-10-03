#!/usr/bin/env node
/** Reproducible, original synthetic inputs. All composition remains editable in Klippt. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.join(repo, "artifacts/agent-proof-2026-09-07");
const force = process.argv.slice(2).includes("--force");
if (process.argv.slice(2).some((arg) => arg !== "--force"))
	throw new Error("Usage: node scripts/create-agent-proof-assets.mjs [--force]");
const names = [
	"screen.png",
	"camera.png",
	"diagram.png",
	"music-bed.wav",
	"cue.wav",
	"screen.mp4",
	"test-camera.mp4",
	"manifest.json",
];
if (!force && names.some((name) => existsSync(path.join(output, name))))
	throw new Error("Proof assets exist. Use --force to regenerate only these known files.");
mkdirSync(output, { recursive: true });
writeFileSync(path.join(output, ".gitignore"), "*\n!.gitignore\n");
function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
	return result.stdout;
}
const ffmpeg = process.env.KLIPPT_PROOF_FFMPEG || "/opt/homebrew/bin/ffmpeg";
const ffprobe = process.env.KLIPPT_PROOF_FFPROBE || "/opt/homebrew/bin/ffprobe";
run("python3", [
	"-c",
	String.raw`
from PIL import Image, ImageDraw, ImageFont
import math, struct, wave, pathlib, sys
out = pathlib.Path(sys.argv[1])
font_path = "/System/Library/Fonts/Helvetica.ttc"
def font(n): return ImageFont.truetype(font_path,n)
def label(d, xy, text, n=32, color="#e8eef8"): d.text(xy,text,font=font(n),fill=color)
# This is screen CONTENT, not an editor background, crop, or animated composition.
im=Image.new("RGB",(1920,1080),"#111827"); d=ImageDraw.Draw(im)
label(d,(80,60),"KLIPPT / SYNTHETIC SOURCE",28,"#82dfca")
label(d,(80,115),"A clear edit starts with clear evidence",58)
label(d,(80,200),"Three source targets for the editor to frame. No effects are baked in.",28,"#a8b6cc")
cards=[("01 / INSPECT","Read the project","Stable clip IDs","Source and edited time","Know what is missing"),("02 / EDIT","Change one thing","Preserve other edits","Use normal project tools","Keep the original media"),("03 / VERIFY","Check the result","View composed frames","Confirm the requested edit","Undo one normal action")]
for i,card in enumerate(cards):
 x=80+i*600
 d.rounded_rectangle((x,330,x+560,850),radius=22,fill="#1c2940",outline="#3a4d69",width=2)
 label(d,(x+30,370),card[0],25,"#82dfca")
 label(d,(x+30,435),card[1],37)
 for j,line in enumerate(card[2:]): label(d,(x+30,550+j*72),line,27,"#cbd5e1")
label(d,(80,960),"TEST FOOTAGE / 1920 x 1080 / 24 seconds / no real desktop or personal content",25,"#8090aa")
im.save(out/"screen.png")
im=Image.new("RGB",(640,360),"#253447");d=ImageDraw.Draw(im)
d.ellipse((247,60,393,206),fill="#59c5b3")
d.rounded_rectangle((188,212,452,258),radius=15,fill="#59c5b3")
label(d,(184,278),"TEST CAMERA",34)
label(d,(185,325),"Synthetic geometric source",18,"#bdcce1")
im.save(out/"camera.png")
im=Image.new("RGBA",(1200,240),(0,0,0,0));d=ImageDraw.Draw(im)
for i,text in enumerate(["Inspect","Edit","Verify"]):
 x=20+i*410
 d.rounded_rectangle((x,45,x+340,195),radius=24,fill=(20,39,60,242),outline="#82dfca",width=4)
 label(d,(x+55,95),text,46)
 if i<2:
  d.line((x+352,120,x+398,120),fill="#82dfca",width=6)
  d.polygon([(x+399,120),(x+383,108),(x+383,132)],fill="#82dfca")
im.save(out/"diagram.png")
# Original sine synthesis; no samples, borrowed music, neural models, or voice.
rate=48000
for name,duration,cue in [("music-bed.wav",24,False),("cue.wav",0.65,True)]:
 with wave.open(str(out/name),"wb") as f:
  f.setnchannels(2);f.setsampwidth(2);f.setframerate(rate)
  block=bytearray()
  for n in range(round(duration*rate)):
   t=n/rate
   fade=min(1,t/0.03,(duration-t)/0.25)
   if cue: v=0.12*fade*math.exp(-t*5)*math.sin(2*math.pi*880*t)
   else:
    chord=[(130.8128,164.8138,195.9977),(110,130.8128,164.8138),(87.3071,110,130.8128),(97.9989,123.4708,146.8324)][min(3,int(t/6))]
    local=t%6; chordfade=min(1,local/0.15,(6-local)/0.2)
    v=0.055*fade*chordfade*sum(math.sin(2*math.pi*hz*t) for hz in chord)/3
   sample=round(max(-1,min(1,v))*32767)
   block.extend(struct.pack("<hh",sample,sample))
   if len(block)>=192000: f.writeframesraw(block);block.clear()
  f.writeframes(block)
`,
	output,
]);
for (const [input, target] of [
	["screen.png", "screen.mp4"],
	["camera.png", "test-camera.mp4"],
]) {
	run(ffmpeg, [
		"-hide_banner",
		"-loglevel",
		"error",
		"-y",
		"-loop",
		"1",
		"-framerate",
		"30",
		"-i",
		path.join(output, input),
		"-t",
		"24",
		"-an",
		"-c:v",
		"h264_videotoolbox",
		"-b:v",
		"4000000",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		path.join(output, target),
	]);
}
const media = names
	.filter((name) => name !== "manifest.json")
	.map((name) => {
		const file = path.join(output, name);
		const probe = JSON.parse(
			run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", file]),
		);
		return {
			name,
			path: file,
			sha256: createHash("sha256").update(readFileSync(file)).digest("hex"),
			streams: probe.streams.map((stream) => ({
				type: stream.codec_type,
				codec: stream.codec_name,
				width: stream.width,
				height: stream.height,
				pixel_format: stream.pix_fmt,
				sample_rate: stream.sample_rate,
				channels: stream.channels,
				frame_rate: stream.avg_frame_rate,
				duration: stream.duration,
			})),
			duration: probe.format.duration ?? null,
		};
	});
const manifest = {
	version: 1,
	purpose: "Original synthetic source assets; not a finished edit or real capture evidence",
	duration_seconds: 24,
	generated_camera: "Clearly labeled geometric test source; no human likeness",
	edits_baked_in: [],
	audio: "Original deterministic sine synthesis; no third-party samples",
	regenerate: "node scripts/create-agent-proof-assets.mjs --force",
	media,
};
writeFileSync(path.join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(
	JSON.stringify(
		{
			output,
			manifest: path.join(output, "manifest.json"),
			files: media.map((item) => ({
				name: item.name,
				streams: item.streams,
				duration: item.duration,
			})),
		},
		null,
		2,
	),
);
