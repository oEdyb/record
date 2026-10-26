import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "@playwright/test";

const output = path.resolve(process.argv[2] ?? "artifacts/hud-installed-redesign");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9337");
const page = browser
	.contexts()
	.flatMap((c) => c.pages())
	.find((p) => p.url().includes("hud-overlay"));
if (!page || !page.url().startsWith("klippt://")) throw Error("Installed HUD missing");
const cdp = await page.context().newCDPSession(page);
const frames = [];
const writes = [];
cdp.on("Page.screencastFrame", (f) => {
	const file = `frame-${String(frames.length).padStart(4, "0")}.jpg`;
	frames.push({ file, timestamp: f.metadata.timestamp });
	writes.push(fs.writeFile(`${output}/${file}`, Buffer.from(f.data, "base64")));
	void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, everyNthFrame: 1 });
console.log(
	"READY: observing installed renderer for 40 seconds; all input comes from desktop automation",
);
const proof = await page.evaluate(
	() =>
		new Promise((resolve) => {
			const bar = document.querySelector("[data-recording-layout]");
			const identity = bar?.querySelector("[data-testid=hud-drag-handle]");
			if (!bar || !identity) throw Error("Missing HUD");
			const start = performance.now(),
				samples = [];
			function sample() {
				const shape = [...bar.querySelectorAll("[data-testid=hud-dock-surface] > span")].map(
					(e) => {
						const r = e.getBoundingClientRect();
						return { x: r.x, y: r.y, width: r.width, height: r.height };
					},
				);
				const row = bar.querySelector(":scope > [class*=hudPillRow]");
				samples.push({
					t: performance.now() - start,
					tucked: bar.dataset.tucked ?? null,
					pinned: bar.dataset.pinned ?? null,
					identitySame: bar.querySelector("[data-testid=hud-drag-handle]") === identity,
					rowOpacity: getComputedStyle(row).opacity,
					shape,
					focus: document.activeElement?.getAttribute("aria-label"),
				});
				if (performance.now() - start < 40000) requestAnimationFrame(sample);
				else resolve({ wallStart: performance.timeOrigin + start, url: location.href, samples });
			}
			requestAnimationFrame(sample);
		}),
);
await cdp.send("Page.stopScreencast");
await Promise.all(writes);
const transitions = proof.samples
	.filter((s, i, a) => i && s.tucked !== a[i - 1].tucked)
	.map((s) => ({ t: s.t, tucked: s.tucked }));
proof.transitions = transitions;
proof.frames = frames;
proof.passed =
	transitions.length >= 4 &&
	proof.samples.every((s) => s.identitySame && s.rowOpacity === "1" && s.shape.length === 3);
await fs.writeFile(`${output}/proof.json`, JSON.stringify(proof, null, 2));
console.log(
	JSON.stringify({
		passed: proof.passed,
		transitions: transitions.length,
		samples: proof.samples.length,
		frames: frames.length,
		output,
	}),
);
await cdp.detach();
await browser.close();
