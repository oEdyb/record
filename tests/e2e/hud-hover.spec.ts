import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		let api: Window["electronAPI"];
		let onDock: ((side: "top" | "left" | "right" | null) => void) | undefined;
		Object.defineProperty(window, "electronAPI", {
			configurable: true,
			get: () => api,
			set: (value: Window["electronAPI"]) => {
				api = value;
				api.getPlatform = () => "darwin";
				api.getCapturePermissions = async () => ({
					screen: "granted",
					microphone: "granted",
					camera: "granted",
				});
				api.requestScreenAccess = async () => ({ success: true, granted: true, status: "granted" });
				api.onHudDockChanged = (callback) => {
					onDock = callback;
					return () => {
						onDock = undefined;
					};
				};
				api.setHudDock = (side) => onDock?.(side);
			},
		});
	});
});

test("one persistent identity morphs between the tab and full controls", async ({ page }) => {
	await page.goto(
		`${process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173"}/?windowType=hud-overlay&browser`,
	);
	const pill = page.locator("[data-recording-layout]");
	await page.getByTestId("hud-tuck-button").click();
	await expect(pill).toHaveAttribute("data-docked", "top");
	await expect(pill).toHaveAttribute("data-tucked", "top");
	const identity = pill.getByTestId("hud-drag-handle");
	const node = await identity.elementHandle();
	const closed = await identity.boundingBox();
	if (!closed || !node) throw new Error("Persistent dock identity has no bounds");
	await expect(identity).toBeVisible();
	await page.mouse.move(closed.x + closed.width / 2, closed.y + closed.height / 2);
	await expect(pill).not.toHaveAttribute("data-tucked");
	await page.waitForTimeout(700);
	await expect(pill.locator(":scope > [class*='hudPillRow']")).toHaveCSS("opacity", "1");
	const opened = await identity.boundingBox();
	expect(opened?.x).toBeCloseTo(closed.x, 1);
	expect(await identity.evaluate((element, original) => element === original, node)).toBe(true);
	await page.waitForTimeout(1200);
	await expect(pill).not.toHaveAttribute("data-tucked");
	await page.screenshot({ path: "artifacts/hud-redesign/expanded.png" });
	await page.mouse.move(5, 5);
	await expect(pill).toHaveAttribute("data-tucked", "top");
	await page.waitForTimeout(700);
	await expect(identity).toBeVisible();
	await expect(pill.locator(":scope > [class*='hudPillRow']")).toHaveCSS("opacity", "1");
	await page.screenshot({ path: "artifacts/hud-redesign/collapsed.png" });
	await identity.click();
	await expect(pill).not.toHaveAttribute("data-tucked");
	await expect(pill).toHaveAttribute("data-pinned", "true");
	await page.mouse.move(5, 5);
	await page.waitForTimeout(1000);
	await expect(pill).not.toHaveAttribute("data-tucked");
	await identity.focus();
	await identity.press("Escape");
	await expect(pill).toHaveAttribute("data-tucked", "top");
	await expect(pill).toHaveAttribute("data-docked", "top");
	await expect(identity).toBeFocused();
	await identity.press("Enter");
	await expect(pill).toHaveAttribute("data-pinned", "true");
	await expect(pill).not.toHaveAttribute("data-tucked");
});

test("panels and keyboard navigation keep attached controls available", async ({ page }) => {
	await page.addInitScript(() =>
		localStorage.setItem(
			"openscreen_user_preferences",
			JSON.stringify({ hudDock: "top", hudMinimized: true }),
		),
	);
	await page.goto(
		`${process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173"}/?windowType=hud-overlay&browser`,
	);
	const pill = page.locator("[data-recording-layout]");
	const identity = pill.getByTestId("hud-drag-handle");
	await expect(pill).toHaveAttribute("data-docked", "top");
	await expect(pill).toHaveAttribute("data-minimized", "false");
	await identity.focus();
	await expect(pill).not.toHaveAttribute("data-tucked");
	await identity.press("Enter");
	const settings = page.getByTestId("launch-device-settings-button");
	await settings.focus();
	await settings.press("Enter");
	const panel = page.getByTestId("hud-device-settings");
	await expect(panel).toBeVisible();
	await expect(pill).toHaveAttribute("data-docked", "top");
	await page.mouse.move(5, 5);
	await page.waitForTimeout(600);
	await expect(pill).not.toHaveAttribute("data-tucked");
	await page.keyboard.press("Escape");
	await expect(settings).toBeFocused();
	const source = page.getByTestId("launch-source-selector-button");
	await source.focus();
	await source.press("Enter");
	const selectedTab = page.getByRole("tab", { selected: true });
	await expect(selectedTab).toBeFocused();
	await selectedTab.press("ArrowRight");
	await expect(page.getByRole("tab", { selected: true })).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(source).toBeFocused();
	await page.emulateMedia({ reducedMotion: "reduce" });
	await identity.focus();
	await identity.press("Escape");
	await expect(pill).toHaveAttribute("data-tucked", "top");
	await expect(page.getByTestId("hud-dock-surface").locator("span").first()).toHaveCSS(
		"transition-duration",
		"0s",
	);
});

test("the same identity survives mid-morph reversals", async ({ page }) => {
	await page.goto(
		`${process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173"}/?windowType=hud-overlay&browser`,
	);
	const pill = page.locator("[data-recording-layout]");
	await page.getByTestId("hud-tuck-button").click();
	await page.mouse.move(5, 5);
	await page.waitForTimeout(750);
	const identity = pill.getByTestId("hud-drag-handle");
	const node = await identity.elementHandle();
	const box = await identity.boundingBox();
	if (!box || !node) throw new Error("Missing persistent identity");
	for (const reversalMs of [150, 300, 450]) {
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await expect(pill).not.toHaveAttribute("data-tucked");
		await page.waitForTimeout(reversalMs);
		await page.screenshot({ path: `artifacts/hud-redesign/open-${reversalMs}.png` });
		await page.mouse.move(5, 5);
		await expect(pill).toHaveAttribute("data-tucked", "top");
		await page.waitForTimeout(reversalMs);
		await page.screenshot({ path: `artifacts/hud-redesign/close-${reversalMs}.png` });
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await expect(pill).not.toHaveAttribute("data-tucked");
		expect(await identity.evaluate((element, original) => element === original, node)).toBe(true);
		await expect(pill.locator(":scope > [class*='hudPillRow']")).toHaveCSS("opacity", "1");
		await page.mouse.move(5, 5);
		await expect(pill).toHaveAttribute("data-tucked", "top");
		await page.waitForTimeout(750);
	}
});

test("side dock keyboard opening and collapse retain a visible focus target", async ({ page }) => {
	await page.goto(
		`${process.env.E2E_BASE_URL ?? "http://127.0.0.1:5173"}/?windowType=hud-overlay&browser`,
	);
	const pill = page.locator("[data-recording-layout]");
	await expect(pill).toBeVisible();
	await page.evaluate(() => window.electronAPI.setHudDock?.("left"));
	const tabGrip = page.getByTestId("hud-dock-tab").getByTestId("hud-drag-handle");
	const barGrip = pill.getByTestId("hud-drag-handle");
	await expect(pill).toHaveAttribute("data-tucked", "left");
	await tabGrip.focus();
	await tabGrip.press("Enter");
	await expect(pill).toHaveAttribute("data-pinned", "true");
	await expect(barGrip).toBeFocused();
	await page.waitForTimeout(700);
	await page.keyboard.press("Escape");
	await expect(pill).toHaveAttribute("data-tucked", "left");
	await expect(tabGrip).toBeFocused();
	await page.waitForTimeout(700);
	await expect(pill).toHaveAttribute("data-tucked", "left");
	await expect(tabGrip).toBeFocused();
});
