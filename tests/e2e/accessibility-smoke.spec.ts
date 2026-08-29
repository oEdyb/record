import { expect, type Locator, type Page, test } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const HUD_URL = `${BASE_URL}/?windowType=hud-overlay`;
const EDITOR_URL = `${BASE_URL}/?windowType=editor`;

const INTERACTIVE = [
	"button",
	"a[href]",
	"input:not([type='hidden'])",
	"select",
	"textarea",
	"[contenteditable='true']",
	"[role='button']",
	"[role='checkbox']",
	"[role='combobox']",
	"[role='menuitem']",
	"[role='menuitemradio']",
	"[role='radio']",
	"[role='separator'][tabindex]",
	"[role='slider']",
	"[role='switch']",
	"[role='tab']",
].join(",");

async function assertNamedInteractive(scope: Locator): Promise<void> {
	const controls = scope.locator(INTERACTIVE);
	const unnamed: string[] = [];
	for (let index = 0; index < (await controls.count()); index += 1) {
		const control = controls.nth(index);
		if (!(await control.isVisible())) continue;
		const snapshot = await control.ariaSnapshot();
		const firstNode = snapshot
			.split("\n")
			.map((line) => line.trim())
			.find((line) => line.startsWith("- "));
		if (!firstNode || !firstNode.includes('"')) {
			unnamed.push(`${await control.evaluate((element) => element.outerHTML.slice(0, 240))}`);
		}
	}
	expect(
		unnamed,
		`interactive controls without an accessible name:\n${unnamed.join("\n")}`,
	).toEqual([]);
}

function makeDocument() {
	return {
		schemaVersion: 5,
		project: {
			id: "proj_accessibility",
			title: "Accessibility fixture",
			createdAt: "2026-08-28T00:00:00.000Z",
			updatedAt: "2026-08-28T00:00:00.000Z",
			primaryAssetId: "asset_accessibility",
		},
		assets: [
			{
				id: "asset_accessibility",
				kind: "video",
				label: "Keyboard recording.mp4",
				originalPath: "/nonexistent/keyboard-recording.mp4",
				durationSec: 12,
				video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip_accessibility",
					assetId: "asset_accessibility",
					sourceStartSec: 0,
					sourceEndSec: 12,
					timelineStartSec: 0,
					timelineEndSec: 12,
					wordRefs: [],
					origin: "system",
					reason: "",
				},
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [
			{
				id: "annotation_accessibility",
				clipId: "clip_accessibility",
				sourceStartSec: 2,
				sourceEndSec: 5,
				startMs: 2_000,
				endMs: 5_000,
				type: "text",
				content: "Keyboard annotation",
				position: { x: 50, y: 50 },
				size: { width: 30, height: 20 },
				style: {
					color: "#ffffff",
					backgroundColor: "transparent",
					fontSize: 32,
					fontFamily: "Inter",
					fontWeight: "bold",
					fontStyle: "normal",
					textDecoration: "none",
					textAlign: "center",
				},
				zIndex: 1,
			},
		],
		zoomRanges: [],
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek", revision: 0 },
		export: { preset: "final-balanced", lastJobId: null },
		history: { revisions: [] },
	};
}

async function seedEditor(page: Page): Promise<void> {
	await page.addInitScript((serialized) => {
		const document = JSON.parse(serialized);
		localStorage.setItem(
			"browser-shim-projects-v2",
			JSON.stringify({
				documents: { [document.project.id]: document },
				order: [document.project.id],
			}),
		);
	}, JSON.stringify(makeDocument()));
	await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded" });
	await expect(page.locator("[data-clip-id]")).toHaveCount(1, { timeout: 15_000 });
}

test("recording HUD has named controls, keyboard tooltip help, and reduced motion", async ({
	page,
}) => {
	await page.goto(HUD_URL, { waitUntil: "domcontentloaded" });
	const hud = page.locator('[data-hud-interactive="true"]').first();
	await expect(hud).toBeVisible();
	await assertNamedInteractive(page.locator("body"));

	const studio = page.getByTestId("launch-open-studio-button");
	await studio.focus();
	await expect(page.getByRole("tooltip")).toContainText("Open Studio");
	await expect
		.poll(() => studio.evaluate((element) => getComputedStyle(element).boxShadow))
		.not.toBe("none");

	const systemAudio = page.getByTestId("launch-system-audio-button");
	await systemAudio.focus();
	await expect(systemAudio).toHaveAttribute("aria-pressed", "false");
	await page.keyboard.press("Space");
	await expect(systemAudio).toHaveAttribute("aria-pressed", "true");

	const normalDuration = await hud.evaluate(
		(element) => getComputedStyle(element).transitionDuration,
	);
	expect(normalDuration).not.toBe("0s");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect
		.poll(() => hud.evaluate((element) => getComputedStyle(element).transitionDuration))
		.toBe("0s");
});

test("editor navigation, dialog focus, and splitters work from the keyboard", async ({ page }) => {
	await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded" });
	await expect(page.getByTestId("preview")).toBeVisible();
	await assertNamedInteractive(page.locator("body"));

	await page.keyboard.press("Tab");
	const openProject = page.getByRole("button", { name: "Open project" }).first();
	await expect(openProject).toBeFocused();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog", { name: "Open project" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByRole("searchbox")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(openProject).toBeFocused();

	const splitter = page.getByRole("separator", { name: "Resize timeline" });
	await splitter.focus();
	const before = Number(await splitter.getAttribute("aria-valuenow"));
	await page.keyboard.press("ArrowUp");
	expect(Number(await splitter.getAttribute("aria-valuenow"))).toBeGreaterThan(before);

	const paneButton = page.getByRole("button", { name: "Video Effects" });
	const normalDuration = await paneButton.evaluate(
		(element) => getComputedStyle(element).transitionDuration,
	);
	expect(normalDuration).not.toBe("0s");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect
		.poll(() => paneButton.evaluate((element) => getComputedStyle(element).transitionDuration))
		.toBe("0s");
});

test("export and annotation projects keep names and normal Tab navigation", async ({ page }) => {
	await seedEditor(page);
	await assertNamedInteractive(page.locator("body"));

	const exportButton = page.getByRole("button", { name: "Export", exact: true });
	await exportButton.focus();
	await page.keyboard.press("Tab");
	await expect(exportButton).not.toBeFocused();

	await exportButton.focus();
	await page.keyboard.press("Enter");
	const dialog = page.getByRole("dialog", { name: "Export" });
	await expect(dialog).toBeVisible();
	await assertNamedInteractive(dialog);

	await dialog.getByRole("button", { name: "GIF" }).click();
	const loop = dialog.getByRole("button", { name: "Loop GIF" });
	await expect(loop).toHaveAttribute("aria-pressed", "true");
	await loop.focus();
	await page.keyboard.press("Space");
	await expect(loop).toHaveAttribute("aria-pressed", "false");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	await expect(exportButton).toBeFocused();
});
