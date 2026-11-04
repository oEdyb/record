import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { acquireRecordingTestLock } from "./recording-test-lock.mjs";

const args = process.argv.slice(2);
const lab =
	process.platform === "linux" &&
	spawnSync("agent-lab", ["--help"], { stdio: "ignore" }).status === 0;
if (lab) acquireRecordingTestLock();
const require = createRequire(import.meta.url);
const vitest = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const unit = spawnSync(process.execPath, [vitest, "--run", "--maxWorkers=4", ...args], {
	stdio: "inherit",
});
if (unit.error) console.error(unit.error.message);
let desktopStatus = 0;
if (args.length === 0 && lab) {
	const desktop = spawnSync(process.execPath, ["scripts/recording-window-flow.mjs"], {
		stdio: "inherit",
	});
	if (desktop.error) console.error(desktop.error.message);
	desktopStatus = desktop.status ?? 1;
} else {
	console.log(
		`Private recording window tests NOT RUN: ${args.length ? "filtered unit run" : "private Linux desktop unavailable"}.`,
	);
}
process.exitCode = unit.status === 0 && desktopStatus === 0 ? 0 : 1;
