// Browser-shim e2e for the v4 editor shell (EditorTopBar + FloatingInspector +
// V4Timeline). Each test seeds a v5 document into the shim's localStorage, opens
// the editor, and asserts on what the user can actually see. Selectors come from
// `src/components/ai-edition/v4/` — stable hooks only (aria-labels, roles,
// `data-clip-id`), plus `[class*="…"]` for the two CSS-module elements that have
// no accessible name (the timeline's tracks + nav window).
//
// Runs against dev or built preview servers (default 5173; override with E2E_BASE_URL).
import { expect, type Page, test } from "@playwright/test";

const BASE_URL = process.env.E2E_BASE_URL ?? "http://localhost:5173";
const EDITOR_URL = `${BASE_URL}/?windowType=editor`;

// 300 MB exactly, so MediaStage's formatSize renders "300 MB".
const SIZED_BYTES = 314_572_800;

function makeDoc({ secondClip = false }: { secondClip?: boolean } = {}) {
	const asset = (id: string, label: string, sizeBytes?: number) => ({
		id,
		kind: "video" as const,
		label,
		originalPath: `C:\\nonexistent\\${id}.mp4`,
		durationSec: 600,
		...(sizeBytes === undefined ? {} : { sizeBytes }),
		video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		cameraTrack: null,
	});
	return {
		schemaVersion: 5,
		project: {
			id: "proj_e2e",
			title: "E2E Fixture",
			createdAt: "2026-07-01T00:00:00.000Z",
			updatedAt: "2026-07-01T00:00:00.000Z",
			primaryAssetId: "asset_sized",
		},
		assets: [asset("asset_sized", "Sized.mp4", SIZED_BYTES), asset("asset_unsized", "Unsized.mp4")],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [
				{
					id: "clip_e2e",
					assetId: "asset_sized",
					sourceStartSec: 0,
					sourceEndSec: 600,
					timelineStartSec: 0,
					timelineEndSec: 600,
					wordRefs: [],
					origin: "system" as const,
					reason: "",
				},
				...(secondClip
					? [
							{
								id: "clip_e2e_second",
								assetId: "asset_unsized",
								sourceStartSec: 0,
								sourceEndSec: 60,
								timelineStartSec: 600,
								timelineEndSec: 660,
								wordRefs: [],
								origin: "system" as const,
								reason: "",
							},
						]
					: []),
			],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		legacyEditor: null,
		agent: { pendingQuestions: [], suggestions: [], lastAppliedOperations: [] },
		preview: { strategy: "seek" as const, revision: 0 },
		export: { preset: "final-balanced" as const, lastJobId: null },
		history: { revisions: [] },
	};
}

async function seedAndOpen(page: Page, options: { secondClip?: boolean } = {}): Promise<void> {
	await page.addInitScript(
		(serialized) => {
			const doc = JSON.parse(serialized);
			// The shim keys documents by project id under one blob (see
			// `createShimBridgeClient` in src/native/browserShim.ts); the shell's mount
			// effect calls listProjects() → loadProject(first) on launch, so seeding
			// this is what lands us in a populated editor.
			localStorage.setItem(
				"browser-shim-projects-v2",
				JSON.stringify({ documents: { [doc.project.id]: doc }, order: [doc.project.id] }),
			);
		},
		JSON.stringify(makeDoc(options)),
	);
	await page.goto(EDITOR_URL, { waitUntil: "domcontentloaded" });
	// listProjects → loadProject are both async. A rendered clip pill is the
	// first observable proof the seeded document reached the timeline.
	await expect(page.locator("[data-clip-id]")).toHaveCount(options.secondClip ? 2 : 1, {
		timeout: 15_000,
	});
}

test.describe("v4 editor shell", () => {
	test("inspector facet header opens a contextual help popover", async ({ page }) => {
		await seedAndOpen(page);

		// The inspector opens on the "effects" facet; the rail buttons are labelled
		// from settings.<facet>.title (FloatingInspector's FACETS).
		await page.getByRole("button", { name: "Background" }).click();
		const help = page.getByRole("button", { name: "Help" });
		await help.click();

		// RightPanes' `Pane` renders the help text in a role="note" popover.
		const popover = page.locator('[role="note"]');
		await expect(popover).toBeVisible();
		// Pane-specific text, not a generic stub: settings.background.help.
		await expect(popover).toContainText("behind the recording");

		await help.click();
		await expect(popover).toBeHidden();
	});

	test("edit clip picker uses a keyboard menu and opens the selected clip", async ({ page }) => {
		await seedAndOpen(page, { secondClip: true });

		await page.getByRole("button", { name: "Edit clip" }).click();
		const menu = page.getByRole("menu", { name: "Edit clip" });
		await expect(menu).toBeVisible();
		await expect(menu.getByRole("menuitem")).toHaveCount(2);

		await menu.getByRole("menuitem", { name: /Clip 2/ }).click();
		await expect(page.getByRole("dialog", { name: "Edit clip" })).toBeVisible();
	});

	test("ctrl+wheel over the tracks zooms the timeline, bounded at 2% of its span", async ({
		page,
	}) => {
		await seedAndOpen(page);

		// The nav window's width mirrors the visible fraction of the timeline
		// (V4Timeline's `nav` state, which the ctrl+wheel handler drives).
		const navWindow = page.locator('[class*="tlNavWindow"]');
		const widthPct = () =>
			navWindow.evaluate((el) => Number.parseFloat((el as HTMLElement).style.width));
		expect(await widthPct()).toBe(100);

		const tracks = page.locator('[class*="tlTracks"]');
		const box = await tracks.boundingBox();
		if (!box) throw new Error("timeline tracks have no bounding box");
		const zoom = async (notches: number) => {
			await page.keyboard.down("Control");
			for (let i = 0; i < notches; i++) {
				await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
				await page.mouse.wheel(0, -120);
			}
			await page.keyboard.up("Control");
		};

		await zoom(3);
		await expect.poll(widthPct).toBeLessThan(100);

		// Each notch divides the span by 1.12; the handler clamps at 0.02, which
		// ~40 more notches overshoots comfortably.
		await zoom(40);
		await expect.poll(widthPct).toBe(2);
	});

	// Exercise normal transport input and ruler scrubbing against the same visible
	// playhead/time readout in both development and production builds. The direct
	// store-subscription regression lives in V4Timeline.geometry.test.tsx.
	test("the playhead stays synchronized with transport seeking and a scrub drag", async ({
		page,
	}) => {
		await seedAndOpen(page);

		// `left` is a percentage of the 600 s fixture timeline. Addressed by position
		// in the overlay rather than by class: `tlPlayhead`, `tlPlayheadLayer` and
		// `tlPlayheadDiamond` all share a `[class*=]` prefix.
		const playhead = page.locator('[class*="tlPlayheadLayer"] > [class*="tlCanvas"] > div');
		const leftPct = () =>
			playhead.evaluate((el) => Number.parseFloat((el as HTMLElement).style.left));
		const transport = page.getByRole("toolbar", { name: /playback/i });
		const seek = transport.getByRole("slider", { name: /seek/i });
		expect(await leftPct()).toBe(0);

		// Keyboard seeking through the normal slider drives the shared transport.
		await seek.press("End");
		await expect(seek).toHaveValue("600");
		await expect.poll(leftPct).toBeCloseTo(100, 1);
		await expect(transport).toContainText("10:00.0");
		await seek.press("Home");
		await expect(seek).toHaveValue("0");
		await expect.poll(leftPct).toBe(0);

		// Scrub: press at 25% of the timeline canvas, drag to 75%, release. The
		// playhead tracks the pointer and the transport confirms the release position.
		// Scrub on the ruler. The main track is covered by the clip, and clip
		// pointer-down intentionally starts selection/drag instead of seeking.
		const canvas = page.locator('[class*="tlRulerRow"] [class*="tlCanvas"]').first();
		const box = await canvas.boundingBox();
		if (!box) throw new Error("timeline canvas has no bounding box");
		const y = box.y + box.height / 2;
		await page.mouse.move(box.x + box.width * 0.25, y);
		await page.mouse.down();
		await expect.poll(leftPct).toBeCloseTo(25, 0);
		await page.mouse.move(box.x + box.width * 0.75, y, { steps: 8 });
		await page.mouse.up();
		await expect.poll(leftPct).toBeCloseTo(75, 0);
		await expect.poll(async () => Number(await seek.inputValue())).toBeCloseTo(450, 0);
		await expect(transport).toContainText("7:30.0");
	});
});

// Compare real control geometry across panes. DOM-only tests cannot detect a
// switch stretched by its surrounding layout, or a thumb hidden by theme colors.
for (const theme of ["light", "dark"]) {
	for (const width of [768, 1280]) {
		test(`inspector switches stay consistent: ${theme}, ${width}px`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width, height: 900 });
			await page.addInitScript((value) => localStorage.setItem("openscreen-theme", value), theme);
			await seedAndOpen(page);
			let checkedCount = 0;
			for (const facet of ["Video Effects", "Layout", "Cursor", "Audio", "Captions"]) {
				await page.getByRole("radio", { name: facet, exact: true }).click();
				const tabs = page.getByRole("tab");
				const taskNames = await tabs.allTextContents();
				for (const task of taskNames.length ? taskNames : [""]) {
					if (task) await page.getByRole("tab", { name: task, exact: true }).click();
					const switches = page.getByRole("switch");
					for (const control of await switches.all()) {
						await control.scrollIntoViewIfNeeded();
						const geometry = await control.evaluate((el) => {
							const box = el.getBoundingClientRect();
							const thumb = el.firstElementChild;
							if (!thumb) throw new Error("Switch has no thumb");
							const thumbBox = thumb.getBoundingClientRect();
							return {
								width: box.width,
								height: box.height,
								thumbWidth: thumbBox.width,
								thumbHeight: thumbBox.height,
								insetY: thumbBox.top - box.top,
								track: getComputedStyle(el, "::before").backgroundColor,
								thumb: getComputedStyle(thumb).backgroundColor,
							};
						});
						expect(geometry).toMatchObject({
							width: 36,
							height: 24,
							thumbWidth: 16,
							thumbHeight: 16,
							insetY: 4,
						});
						expect(geometry.thumb).not.toBe(geometry.track);
						checkedCount++;
					}
					await page.screenshot({
						path: testInfo.outputPath(`${facet}-${task || "settings"}.png`),
						animations: "disabled",
					});
				}
			}
			expect(checkedCount).toBeGreaterThanOrEqual(8);
			await page.getByRole("radio", { name: "Cursor", exact: true }).click();
			const cursor = page.getByRole("switch", { name: "Show Cursor", exact: true });
			const before = await cursor.isChecked();
			await cursor.focus();
			await page.keyboard.press("Space");
			await expect(cursor).toBeChecked({ checked: !before });
			await expect(cursor).toBeFocused();
			await page.keyboard.press("Space");
			await expect(cursor).toBeChecked({ checked: before });
			await page.getByRole("button", { name: "Export", exact: true }).click();
			await page.getByRole("button", { name: "GIF", exact: true }).click();
			const loop = page.getByRole("switch", { name: "Loop GIF", exact: true });
			await loop.scrollIntoViewIfNeeded();
			const loopBox = await loop.boundingBox();
			expect(loopBox).toMatchObject({ width: 36, height: 24 });
			const loopBefore = await loop.isChecked();
			await loop.click();
			await expect(loop).toBeChecked({ checked: !loopBefore });
			await page.screenshot({
				path: testInfo.outputPath("Export-GIF.png"),
				animations: "disabled",
			});
		});
	}
}
