const FLAGS = new Set([
	"app-root",
	"phase",
	"out",
	"source",
	"durations",
	"warm",
	"static",
	"pause",
	"export",
	"fullscreen",
	"audio",
	"kill-helper",
	"pause-stop",
	"review-smoke",
	"change-source",
	"remove-zero",
]);
const BOOLEAN_FLAGS = new Set([
	"warm",
	"static",
	"pause",
	"export",
	"fullscreen",
	"kill-helper",
	"pause-stop",
	"review-smoke",
	"change-source",
	"remove-zero",
]);

export function parseProfileArgs(argv) {
	const options = {};
	for (let index = 0; index < argv.length; index += 2) {
		const flag = argv[index];
		const value = argv[index + 1];
		if (!flag.startsWith("--") || !FLAGS.has(flag.slice(2))) {
			throw new Error(`Unknown profile option: ${flag}`);
		}
		const name = flag.slice(2);
		if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
		if (BOOLEAN_FLAGS.has(name) && !["true", "false"].includes(value)) {
			throw new Error(`${flag} must be true or false`);
		}
		options[name] = value;
	}
	if (options.phase && !["baseline", "after", "smoke"].includes(options.phase)) {
		throw new Error("--phase must be baseline, after, or smoke");
	}
	if (
		options.durations &&
		options.durations.split(",").some((value) => {
			const seconds = Number(value);
			return !value || !Number.isFinite(seconds) || seconds <= 0;
		})
	)
		throw new Error("--durations must contain positive seconds separated by commas");
	if (options.audio && !["none", "microphone", "system", "both"].includes(options.audio)) {
		throw new Error("--audio must be none, microphone, system, or both");
	}
	return options;
}

export function median(values) {
	if (!values.length || values.some((value) => !Number.isFinite(value))) {
		throw new Error("Median requires finite measurements");
	}
	const sorted = [...values].sort((a, b) => a - b);
	const center = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[center] : (sorted[center - 1] + sorted[center]) / 2;
}

export function completedStopSince(history, previousStopCount) {
	const stops = history.filter((event) => event.name === "stop-native-mac-recording");
	if (stops.length <= previousStopCount) return null;
	const stop = stops.at(-1);
	return Number.isFinite(stop.finishedAt) && stop.result ? stop : null;
}

export function reviewMatchesRecording(previewDuration, sourceDuration) {
	return (
		Number.isFinite(previewDuration) &&
		Number.isFinite(sourceDuration) &&
		sourceDuration > 0 &&
		Math.abs(previewDuration - sourceDuration) < 0.25
	);
}

export function compareProfiles(before, after) {
	for (const report of [before, after]) {
		if (report.status !== "passed" || report.recordings.length < 3) {
			throw new Error("Performance proof requires two successful reports with three real starts");
		}
		const duration = Number(report.sourceProbe?.format?.duration);
		if (!Number.isFinite(duration) || duration < 119.5) {
			throw new Error("Performance proof requires a two-minute recording");
		}
		if (
			report.recordings.some(
				(recording) =>
					!Number.isFinite(recording.clickToRecordingMs) || recording.clickToRecordingMs <= 0,
			)
		) {
			throw new Error("Performance proof requires real positive start timings");
		}
		if (!Number.isFinite(report.export?.wallMs) || report.export.wallMs <= 0) {
			throw new Error("Performance proof requires a completed export");
		}
		const exportDuration = Number(report.export?.probe?.format?.duration);
		if (
			!Number.isFinite(exportDuration) ||
			exportDuration < 119.5 ||
			Math.abs(exportDuration - duration) > 0.25
		) {
			throw new Error("Performance proof requires the whole two-minute exported clip");
		}
	}
	const exportSource = (report) =>
		report.export.sourceSha256 ?? report.loadedSource?.sha256 ?? report.sourceSha256;
	const beforeSource = exportSource(before);
	if (!/^[a-f0-9]{64}$/.test(beforeSource ?? "") || beforeSource !== exportSource(after)) {
		throw new Error("Export comparison requires the exact same recorded source");
	}
	const recordBeforeMs = median(before.recordings.map((recording) => recording.clickToRecordingMs));
	const recordAfterMs = median(after.recordings.map((recording) => recording.clickToRecordingMs));
	const exportBeforeMs = before.export.wallMs;
	const exportAfterMs = after.export.wallMs;
	return {
		recordBeforeMs,
		recordAfterMs,
		exportBeforeMs,
		exportAfterMs,
		recordReductionPercent: (1 - recordAfterMs / recordBeforeMs) * 100,
		exportReductionPercent: (1 - exportAfterMs / exportBeforeMs) * 100,
		bothFaster: recordAfterMs < recordBeforeMs && exportAfterMs < exportBeforeMs,
	};
}

export function createTerminalFixture(title) {
	return String.raw`<!doctype html><meta charset=utf-8><title>${title}</title><style>*{box-sizing:border-box}body{margin:0;background:#111319;color:#f2f3f8;font:18px/1.6 ui-monospace,monospace;padding:24px}header{border-bottom:1px solid #3d4f52;padding-bottom:12px;color:#94dbc2}main{white-space:pre-wrap}strong{color:#8ad4ff}#clock{float:right}footer{position:fixed;bottom:30px;color:#e5b077}.cursor{display:inline-block;width:10px;height:18px;background:#f2f3f8;animation:pulse 1s infinite}@keyframes pulse{50%{opacity:0}}.bar{background:#43be96;height:4px;width:35%;animation:sweep 3s linear infinite}@keyframes sweep{to{transform:translateX(800px)}}</style><header>olle@mac ~/dev/klippt<span id=clock></span></header><main id=lines></main><footer>$ npm test <span class=cursor></span><div class=bar></div></footer><script>const start=performance.now();let n=0;setInterval(()=>{n++;document.querySelector('#lines').innerHTML=Array.from({length:16},(_,i)=>'<strong> PASS </strong> recorder '+(n+i).toString().padStart(4,'0')+' capture frame pipeline '+((n+i)*17)+'ms').join('\n')},250);function f(t){document.querySelector('#clock').textContent=((t-start)/1000).toFixed(3)+' s';requestAnimationFrame(f)}requestAnimationFrame(f)</script>`;
}
