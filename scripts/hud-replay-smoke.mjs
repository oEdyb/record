import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { _electron, expect } from "@playwright/test";

const run = promisify(execFile);
const root = process.cwd();
const validControl = process.env.REPLAY_VALID_CONTROL === "1";
const output = path.resolve(process.argv[2] ?? `artifacts/hud-replay-smoke/${Date.now()}`);
if (!output.startsWith(`${path.join(root, "artifacts")}${path.sep}`)) {
	throw new Error("Replay fixture output must stay inside this repository's artifacts directory");
}
await fs.mkdir(output, { recursive: true });
const clip = path.join(output, "synthetic.mp4");
await run(process.env.FFMPEG_PATH ?? "/opt/homebrew/bin/ffmpeg", [
	"-nostdin",
	"-hide_banner",
	"-loglevel",
	"error",
	"-y",
	"-f",
	"lavfi",
	"-i",
	"testsrc2=size=320x180:rate=24",
	"-t",
	"6",
	"-c:v",
	"libx264",
	"-pix_fmt",
	"yuv420p",
	"-movflags",
	"+faststart",
	clip,
]);
const fixturePath = `${path.relative(root, output).split(path.sep).join("/")}/fixture.html`;
await fs.writeFile(
	path.join(output, "fixture.html"),
	`<!doctype html><html><head><title>Isolated replay recovery fixture</title></head><body><div id="root"></div><script type="module" src="./fixture.tsx"></script></body></html>`,
);
await fs.writeFile(
	path.join(output, "fixture.tsx"),
	`
import React from 'react';
import {createRoot} from 'react-dom/client';
import {HudClipPeek} from '/src/components/launch/HudClipPeek.tsx';
import '/src/index.css';
import '/src/styles/design-tokens.css';
document.body.style.background = '#101318';
document.getElementById('root').style.cssText = 'padding:30px;display:flex;justify-content:center';
createRoot(document.getElementById('root')).render(<HudClipPeek open={true} onClose={()=>{}} clips={[
 {index:0, screenVideoPath:${JSON.stringify(clip)}, durationMs:6000},
 {index:1, screenVideoPath:'/removed-fixture.mp4', durationMs:9000, removed:true}
]} labels={{title:'Replay',clipOf:(n,total)=>n+' of '+total,play:'Play',pause:'Pause',mute:'Mute',unmute:'Unmute',volume:'Volume',seek:'Seek',playbackError:'Unable to play this clip',retry:'Try again'}}/>);
`,
);
await fs.writeFile(
	path.join(output, "main.cjs"),
	`
const {app,BrowserWindow,protocol,session} = require('electron');
const fs = require('node:fs/promises');
app.setPath('userData', ${JSON.stringify(path.join(output, "profile"))});
app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');
protocol.registerSchemesAsPrivileged([{scheme:'klippt',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);
global.replayFixture={allowMedia:${validControl},requests:[]};
app.whenReady().then(async()=>{
 session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
 session.defaultSession.setPermissionCheckHandler(()=>false);
 protocol.handle('klippt', async request=>{
  const url=new URL(request.url);
  const requested=Buffer.from(url.pathname.slice('/__media__/'.length),'base64url').toString();
  const allowed=global.replayFixture.allowMedia && requested===${JSON.stringify(clip)};
  global.replayFixture.requests.push({url:request.url,allowed,time:Date.now()});
  if(!allowed) return new Response('Fixture media unavailable',{status:404,headers:{'Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}});
  return new Response(await fs.readFile(${JSON.stringify(clip)}),{headers:{'Content-Type':'video/mp4','Access-Control-Allow-Origin':'*','Cache-Control':'no-store'}});
 });
 const win=new BrowserWindow({width:760,height:520,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 await win.loadURL(${JSON.stringify(`${process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173"}/${fixturePath}`)});
});
app.on('window-all-closed',()=>app.quit());
`,
);

let app;
let page;
const proof = { output, media: clip, synthetic: true, capturePermissionsDenied: true, errors: [] };
try {
	app = await _electron.launch({ args: [path.join(output, "main.cjs")], cwd: root });
	page = await app.firstWindow();
	page.on("pageerror", (error) => proof.errors.push(String(error)));
	page.on("console", (message) => {
		if (message.type() === "error") proof.errors.push(message.text());
	});
	page.on("requestfailed", (request) =>
		proof.errors.push(`${request.url()}: ${request.failure()?.errorText}`),
	);
	if (!validControl) {
		await expect(page.getByRole("alert")).toHaveText("Unable to play this clip");
		await expect(page.getByTestId("hud-clip-peek-play")).toHaveAccessibleName("Play");
	}
	const video = page.getByTestId("hud-clip-peek-video");
	const before = await video.evaluate((element) => ({
		src: element.currentSrc || element.src,
		time: element.currentTime,
		paused: element.paused,
		error: element.error?.code ?? null,
	}));
	if (!validControl) {
		await page.screenshot({ path: path.join(output, "failed.png") });
		proof.enabled = await app.evaluate(() => {
			global.replayFixture.allowMedia = true;
			return global.replayFixture.allowMedia;
		});
		await page.getByRole("button", { name: "Try again" }).click();
	}
	await expect(page.getByRole("alert")).toHaveCount(0);
	await expect.poll(() => video.evaluate((element) => element.videoWidth)).toBe(320);
	await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(1.05);
	const recovered = await video.evaluate((element) => ({
		src: element.currentSrc || element.src,
		time: element.currentTime,
		paused: element.paused,
		error: element.error?.code ?? null,
		width: element.videoWidth,
		height: element.videoHeight,
		decodedFrames: element.getVideoPlaybackQuality().totalVideoFrames,
	}));
	expect(new URL(recovered.src).pathname).toBe(new URL(before.src).pathname);
	expect(recovered.paused).toBe(false);
	expect(recovered.error).toBeNull();
	expect(recovered.decodedFrames).toBeGreaterThan(0);
	await page.screenshot({ path: path.join(output, "recovered.png") });
	proof.before = before;
	proof.recovered = recovered;
	proof.requests = await app.evaluate(() => global.replayFixture.requests);
	proof.passed = true;
	proof.validControlOnly = validControl;
} catch (error) {
	proof.passed = false;
	proof.failure = String(error);
	if (page) {
		proof.mediaFailure = await page
			.getByTestId("hud-clip-peek-video")
			.evaluate((element) => ({
				src: element.currentSrc || element.src,
				readyState: element.readyState,
				error: element.error && { code: element.error.code, message: element.error.message },
			}))
			.catch(() => null);
		await page.screenshot({ path: path.join(output, "failure.png") }).catch(() => undefined);
	}
	throw error;
} finally {
	if (app) {
		proof.requests = await app.evaluate(() => global.replayFixture.requests).catch(() => []);
		await app.close();
	}
	await fs.writeFile(path.join(output, "proof.json"), JSON.stringify(proof, null, 2));
	console.log(JSON.stringify(proof, null, 2));
}
