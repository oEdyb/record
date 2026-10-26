import fs from "node:fs/promises";
import path from "node:path";
import { chromium, expect } from "@playwright/test";

const output = path.resolve(process.argv[2] ?? "artifacts/hud-motion-installed/latest");
await fs.mkdir(output, { recursive: true });
const browser = await chromium.connectOverCDP(process.env.CDP_ENDPOINT ?? "http://127.0.0.1:9337");
const page = browser
	.contexts()
	.flatMap((c) => c.pages())
	.find((p) => p.url().includes("hud-overlay"));
if (!page || !page.url().startsWith("klippt://")) throw Error("Installed HUD is not open");
const cdp = await page.context().newCDPSession(page);
const pill = page.locator("[data-recording-layout]");
const tab = page.getByTestId("hud-dock-tab");
await expect(pill).toHaveAttribute("data-recording-layout", "idle");
if (!(await tab.count()) || (await tab.getAttribute("data-side")) !== "top") {
	await page.evaluate(() => window.electronAPI.setHudDock("top"));
}
await expect(pill).toHaveAttribute("data-docked", "top");
await page.waitForTimeout(500);
await page.mouse.move(10, 10);
await page.waitForTimeout(700);
const bounds = await tab.boundingBox();
const bar = await pill.boundingBox();
const clip = {
	x: Math.max(0, bar.x - 35),
	y: Math.max(0, bounds.y - 5),
	width: bar.width + 70,
	height: 95,
};
const frames = [];
let index = 0;
cdp.on("Page.screencastFrame", async (frame) => {
	const name = `frame-${String(index++).padStart(4, "0")}.jpg`;
	frames.push({ name, timestamp: frame.metadata.timestamp });
	await fs.writeFile(path.join(output, name), Buffer.from(frame.data, "base64"));
	await cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => undefined);
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1 });
await page.evaluate(() => {
	window.__hudMotion = { start: performance.now(), samples: [], events: [] };
	window.__hudMotion.wallStart = performance.timeOrigin + window.__hudMotion.start;
	const sample = () => {
		const el = document.querySelector("[data-recording-layout]");
		const row = el.querySelector(":scope > [class*=hudPillRow]");
		const tab = document.querySelector("[data-testid=hud-dock-tab]");
		window.__hudMotion.samples.push({
			t: performance.now() - window.__hudMotion.start,
			tucked: el.dataset.tucked ?? null,
			clip: getComputedStyle(el).clipPath,
			surface: [...el.querySelectorAll("[data-testid=hud-dock-surface] > span")].map((p) => ({
				transform: getComputedStyle(p).transform,
				rect: p.getBoundingClientRect().toJSON(),
			})),
			rowOpacity: getComputedStyle(row).opacity,
			tabOpacity: tab ? getComputedStyle(tab).opacity : null,
			animations: el
				.getAnimations()
				.map((a) => ({ property: a.transitionProperty, time: a.currentTime })),
		});
		if (performance.now() - window.__hudMotion.start < 5000) requestAnimationFrame(sample);
	};
	requestAnimationFrame(sample);
	for (const type of ["pointerenter", "pointerleave", "transitionstart", "transitionend"])
		document.addEventListener(
			type,
			(event) =>
				window.__hudMotion.events.push({
					t: performance.now() - window.__hudMotion.start,
					type,
					target:
						event.target?.dataset?.testid ||
						event.target?.parentElement?.dataset?.testid ||
						event.target?.className,
					property: event.propertyName,
				}),
			true,
		);
});
await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 5);
await page.waitForTimeout(850);
await expect(pill).not.toHaveAttribute("data-tucked");
await page.screenshot({ path: path.join(output, "expanded.png"), clip });
await page.mouse.move(10, 10);
await page.waitForTimeout(1050);
await expect(pill).toHaveAttribute("data-tucked", "top");
await page.screenshot({ path: path.join(output, "collapsed.png"), clip });
await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 5);
await page.waitForTimeout(210);
await expect(pill).not.toHaveAttribute("data-tucked");
await page.mouse.move(10, 10);
await page.waitForTimeout(410);
await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 5);
await expect(pill).not.toHaveAttribute("data-tucked", { timeout: 100 });
await page.waitForTimeout(700);
await page.mouse.move(10, 10);
await page.waitForTimeout(1050);
await cdp.send("Page.stopScreencast");
const motion = await page.evaluate(() => window.__hudMotion);
const blankSamples = motion.samples.filter(
	(sample) => Number(sample.rowOpacity) < 0.05 && Number(sample.tabOpacity) < 0.05,
).length;
const seamGaps = motion.samples.flatMap((sample) => {
	if (sample.surface.length !== 3) return [];
	const [left, center, right] = sample.surface.map((part) => part.rect);
	return [Math.abs(left.right - center.left), Math.abs(center.right - right.left)];
});
const summary = { blankSamples, maxSeamGap: Math.max(0, ...seamGaps) };
await fs.writeFile(
	path.join(output, "motion.json"),
	JSON.stringify({ ...motion, frames, clip, bounds, bar, summary }, null, 2),
);
console.log(
	JSON.stringify(
		{
			output,
			...summary,
			frames: frames.length,
			samples: motion.samples.length,
			states: [...new Set(motion.samples.map((s) => s.tucked))],
			events: motion.events.filter(
				(e) =>
					e.type.startsWith("transition") &&
					(String(e.target).includes("hudBar") || e.target === "hud-dock-surface"),
			),
		},
		null,
		2,
	),
);
await expect(pill).toHaveAttribute("data-tucked", "top");
expect(blankSamples).toBe(0);
expect(summary.maxSeamGap).toBeLessThan(0.5);
await browser.close();
