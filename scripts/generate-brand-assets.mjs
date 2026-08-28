// Generates every raster app-icon size and the macOS .icns file from one vector mark.
//
// To change the logo later:
//   1. Replace design/assets/klippt-mark.svg while keeping its square viewBox.
//   2. Run `npm run assets:brand`.
//
// The canonical SVG stays neutral. This generator owns each platform treatment:
// an off-white squircle for app launch surfaces and a transparent monochrome glyph
// for the macOS menu bar.

import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { chromium } from "playwright";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = path.join(ROOT, "design", "assets", "klippt-mark.svg");
const PNG_DIR = path.join(ROOT, "icons", "icons", "png");
const ICNS_PATH = path.join(ROOT, "icons", "icons", "mac", "icon.icns");
const PUBLIC_DIR = path.join(ROOT, "public");
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const SURFACE_SCALE = Object.freeze({
	app: 0.66,
	template: 1.02,
});
const ICONSET_FILES = new Map([
	["icon_16x16.png", 16],
	["icon_16x16@2x.png", 32],
	["icon_32x32.png", 32],
	["icon_32x32@2x.png", 64],
	["icon_128x128.png", 128],
	["icon_128x128@2x.png", 256],
	["icon_256x256.png", 256],
	["icon_256x256@2x.png", 512],
	["icon_512x512.png", 512],
	["icon_512x512@2x.png", 1024],
]);

function validateSource(svg) {
	const marker = '<g id="klippt-mark" fill="currentColor">';
	if (!svg.includes(marker)) {
		throw new Error(`${SOURCE} must contain the canonical klippt-mark group`);
	}
	return svg;
}

async function renderPng(page, svg, size, surface) {
	const dataUrl = await page.evaluate(
		async ([source, outputSize, outputSurface, surfaceScale]) => {
			const image = new Image();
			await new Promise((resolve, reject) => {
				image.onload = resolve;
				image.onerror = () => reject(new Error("Could not decode the Klippt SVG"));
				image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
			});

			const canvas = document.createElement("canvas");
			canvas.width = outputSize;
			canvas.height = outputSize;
			const context = canvas.getContext("2d");
			if (!context) throw new Error("Canvas 2D is unavailable");

			context.clearRect(0, 0, outputSize, outputSize);
			if (outputSurface === "app") {
				const center = outputSize / 2;
				const radius = outputSize * 0.46;
				const exponent = 4.6;
				context.beginPath();
				for (let step = 0; step <= 256; step += 1) {
					const angle = (step / 256) * Math.PI * 2;
					const cosine = Math.cos(angle);
					const sine = Math.sin(angle);
					const x = center + radius * Math.sign(cosine) * Math.abs(cosine) ** (2 / exponent);
					const y = center + radius * Math.sign(sine) * Math.abs(sine) ** (2 / exponent);
					if (step === 0) context.moveTo(x, y);
					else context.lineTo(x, y);
				}
				context.closePath();
				context.fillStyle = "#f2f1ee";
				context.fill();
			}

			const artSize = outputSize * surfaceScale;
			const inset = (outputSize - artSize) / 2;
			context.drawImage(image, inset, inset, artSize, artSize);
			return canvas.toDataURL("image/png");
		},
		[svg, size, surface, SURFACE_SCALE[surface]],
	);
	return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function resolveChromiumExecutable() {
	const bundled = chromium.executablePath();
	try {
		await access(bundled);
		return bundled;
	} catch {
		// Playwright can leave valid cached browsers behind after its package version changes.
	}

	const playwrightCache = path.join(homedir(), "Library", "Caches", "ms-playwright");
	try {
		const cached = (await readdir(playwrightCache))
			.filter((name) => name.startsWith("chromium_headless_shell-"))
			.sort()
			.reverse();
		for (const directory of cached) {
			const executable = path.join(
				playwrightCache,
				directory,
				"chrome-headless-shell-mac-arm64",
				"chrome-headless-shell",
			);
			try {
				await access(executable);
				return executable;
			} catch {
				// Try the next cached browser.
			}
		}
	} catch {
		// The cache does not exist yet.
	}

	throw new Error("No Chromium executable is available. Run `npx playwright install chromium`.");
}

const source = validateSource(await readFile(SOURCE, "utf8"));
await mkdir(PNG_DIR, { recursive: true });
await mkdir(path.dirname(ICNS_PATH), { recursive: true });
await mkdir(PUBLIC_DIR, { recursive: true });

const browser = await chromium.launch({ executablePath: await resolveChromiumExecutable() });
try {
	const page = await browser.newPage();
	await page.goto("about:blank");
	for (const size of PNG_SIZES) {
		await writeFile(
			path.join(PNG_DIR, `${size}x${size}.png`),
			await renderPng(page, source, size, "app"),
		);
	}
	await writeFile(
		path.join(PUBLIC_DIR, "klippt-trayTemplate.png"),
		await renderPng(page, source, 16, "template"),
	);
	await writeFile(
		path.join(PUBLIC_DIR, "klippt-trayTemplate@2x.png"),
		await renderPng(page, source, 32, "template"),
	);
} finally {
	await browser.close();
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "klippt-brand-"));
const iconset = path.join(temporaryRoot, "Klippt.iconset");
try {
	await mkdir(iconset);
	for (const [filename, size] of ICONSET_FILES) {
		await writeFile(
			path.join(iconset, filename),
			await readFile(path.join(PNG_DIR, `${size}x${size}.png`)),
		);
	}
	await execFileAsync("/usr/bin/iconutil", ["-c", "icns", iconset, "-o", ICNS_PATH]);
} finally {
	await rm(temporaryRoot, { recursive: true, force: true });
}

console.log(
	`Generated ${PNG_SIZES.length} app icons, ${path.relative(ROOT, ICNS_PATH)}, and 2 menu-bar templates`,
);
