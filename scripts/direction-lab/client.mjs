import { buildLabComparison } from "./policy.mjs";

const data = await fetch("./data.json").then((response) => response.json());
const video = document.querySelector("#source");
const playButton = document.querySelector("#play");
const loopInput = document.querySelector("#loop");
const timeLabel = document.querySelector("#time");
const scrubber = document.querySelector("#scrubber");
const chainSelect = document.querySelector("#chain");
const clickTrack = document.querySelector("#click-track");
const comparisonElement = document.querySelector("#comparison");
const inputs = {
	scale: document.querySelector("#scale"),
	safe: document.querySelector("#safe"),
	anticipation: document.querySelector("#anticipation"),
	panMin: document.querySelector("#pan-min"),
	panMax: document.querySelector("#pan-max"),
};

let comparison;
let panels = [];
let frameRequest = 0;
let lastPreviewFrameAt = -Infinity;

const PREVIEW_FRAMES_PER_SECOND = 30;
const PREVIEW_FRAME_INTERVAL_MS = 1_000 / PREVIEW_FRAMES_PER_SECOND;
const PREVIEW_PIXEL_RATIO = 1;

playButton.disabled = true;

document.querySelector("#source-label").textContent =
	`${data.videoName} · ${data.samples.length.toLocaleString()} cursor samples`;

function formatTime(seconds) {
	const minutes = Math.floor(seconds / 60);
	const remainder = seconds - minutes * 60;
	return `${String(minutes).padStart(2, "0")}:${remainder.toFixed(3).padStart(6, "0")}`;
}

function selectedChain() {
	return data.chains.find((chain) => chain.id === chainSelect.value) ?? data.chains[0];
}

function policyFromControls() {
	const minimumPanMs = Number(inputs.panMin.value);
	const maximumPanMs = Math.max(minimumPanMs, Number(inputs.panMax.value));
	if (maximumPanMs !== Number(inputs.panMax.value)) inputs.panMax.value = String(maximumPanMs);
	return {
		requestedScale: Number(inputs.scale.value),
		safeInset: Number(inputs.safe.value),
		anticipationMs: Number(inputs.anticipation.value),
		minimumPanMs,
		maximumPanMs,
		durationMs: Number.isFinite(video.duration) ? video.duration * 1_000 : undefined,
	};
}

function updateOutputs() {
	document.querySelector("#scale-output").textContent = `${Number(inputs.scale.value).toFixed(2)}×`;
	document.querySelector("#safe-output").textContent =
		`${Math.round(Number(inputs.safe.value) * 100)}%`;
	document.querySelector("#anticipation-output").textContent = `${inputs.anticipation.value} ms`;
	document.querySelector("#pan-min-output").textContent = `${inputs.panMin.value} ms`;
	document.querySelector("#pan-max-output").textContent = `${inputs.panMax.value} ms`;
}

function frameAtTime(variant, timeMs) {
	const index = Math.max(
		0,
		Math.min(
			variant.frames.length - 1,
			Math.round(
				((timeMs - comparison.window.startMs) * comparison.policy.framesPerSecond) / 1_000,
			),
		),
	);
	return variant.frames[index];
}

function resizeCanvas(canvas) {
	const ratio =
		video.videoWidth > 0 && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 10;
	const width = Math.max(320, Math.round(canvas.clientWidth * PREVIEW_PIXEL_RATIO));
	const height = Math.round(width / ratio);
	if (canvas.width !== width || canvas.height !== height) {
		canvas.width = width;
		canvas.height = height;
	}
}

function drawPanel(panel, variant, timeMs) {
	const { canvas, context } = panel;
	resizeCanvas(canvas);
	const frame = frameAtTime(variant, timeMs);
	const width = canvas.width;
	const height = canvas.height;
	context.clearRect(0, 0, width, height);

	if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
		const sourceWidth = video.videoWidth / frame.scale;
		const sourceHeight = video.videoHeight / frame.scale;
		const sourceX = (frame.cx - 0.5 / frame.scale) * video.videoWidth;
		const sourceY = (frame.cy - 0.5 / frame.scale) * video.videoHeight;
		context.drawImage(video, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, width, height);
	} else {
		context.fillStyle = "#111113";
		context.fillRect(0, 0, width, height);
	}

	const safeInset = comparison.policy.safeInset / 2;
	context.save();
	context.setLineDash([7 * PREVIEW_PIXEL_RATIO, 7 * PREVIEW_PIXEL_RATIO]);
	context.lineWidth = Math.max(1, PREVIEW_PIXEL_RATIO);
	context.strokeStyle = "rgba(255,255,255,.34)";
	context.strokeRect(
		width * safeInset,
		height * safeInset,
		width * (1 - safeInset * 2),
		height * (1 - safeInset * 2),
	);
	context.restore();

	const viewportLeft = frame.cx - 0.5 / frame.scale;
	const viewportTop = frame.cy - 0.5 / frame.scale;
	const cursorX = (frame.cursorX - viewportLeft) * frame.scale * width;
	const cursorY = (frame.cursorY - viewportTop) * frame.scale * height;
	const recentClick = comparison.clicks.find((click) => Math.abs(click.timeMs - timeMs) <= 135);
	if (recentClick && frame.cursorVisible) {
		context.beginPath();
		context.arc(cursorX, cursorY, 18 * PREVIEW_PIXEL_RATIO, 0, Math.PI * 2);
		context.strokeStyle = "rgba(167,139,250,.92)";
		context.lineWidth = 2 * PREVIEW_PIXEL_RATIO;
		context.stroke();
	}
	if (frame.cursorVisible) {
		context.beginPath();
		context.arc(cursorX, cursorY, 5 * PREVIEW_PIXEL_RATIO, 0, Math.PI * 2);
		context.fillStyle = "#67e8f9";
		context.shadowColor = "rgba(0,0,0,.8)";
		context.shadowBlur = 5 * PREVIEW_PIXEL_RATIO;
		context.fill();
		context.shadowBlur = 0;
	}

	context.fillStyle = "rgba(8,8,10,.72)";
	context.fillRect(
		width - 72 * PREVIEW_PIXEL_RATIO,
		10 * PREVIEW_PIXEL_RATIO,
		60 * PREVIEW_PIXEL_RATIO,
		25 * PREVIEW_PIXEL_RATIO,
	);
	context.fillStyle = "#f4f4f5";
	context.font = `${11 * PREVIEW_PIXEL_RATIO}px ui-monospace, SFMono-Regular, Menlo, monospace`;
	context.textAlign = "center";
	context.textBaseline = "middle";
	context.fillText(
		`${frame.scale.toFixed(2)}×`,
		width - 42 * PREVIEW_PIXEL_RATIO,
		22.5 * PREVIEW_PIXEL_RATIO,
	);

	canvas.style.outline = frame.visibleSafe ? "none" : "2px solid #ef4444";
}

function render() {
	if (!comparison) return;
	let timeMs = video.currentTime * 1_000;
	if (timeMs >= comparison.window.endMs) {
		if (loopInput.checked) {
			video.currentTime = comparison.window.startMs / 1_000;
		} else if (!video.paused) {
			video.pause();
			video.currentTime = comparison.window.endMs / 1_000;
		}
		timeMs = video.currentTime * 1_000;
	}
	timeLabel.textContent = formatTime(video.currentTime);
	scrubber.value = String(video.currentTime);
	for (let index = 0; index < panels.length; index += 1) {
		drawPanel(panels[index], comparison.variants[index], timeMs);
	}
	frameRequest = 0;
}

function animationLoop(timestamp) {
	if (video.paused) {
		frameRequest = 0;
		return;
	}
	if (timestamp - lastPreviewFrameAt >= PREVIEW_FRAME_INTERVAL_MS) {
		lastPreviewFrameAt = timestamp;
		render();
	}
	if (!video.paused) frameRequest = requestAnimationFrame(animationLoop);
}

function startAnimationLoop() {
	if (frameRequest) cancelAnimationFrame(frameRequest);
	lastPreviewFrameAt = -Infinity;
	frameRequest = requestAnimationFrame(animationLoop);
}

function rebuildPanels() {
	comparisonElement.replaceChildren();
	panels = comparison.variants.map((variant) => {
		const section = document.createElement("section");
		section.className = "variant";
		const statusClass = variant.croppedFrames === 0 ? "status" : "status warn";
		const statusText =
			variant.croppedFrames === 0 ? "Cursor visible" : `${variant.croppedFrames} cropped frames`;
		section.innerHTML = `
			<div class="variant-heading">
				<div class="variant-title-row"><h2></h2><span class="${statusClass}">${statusText}</span></div>
				<p></p>
			</div>
			<div class="canvas-wrap"><canvas></canvas></div>
			<div class="metrics">
				<span>Zoom <strong>${variant.resolvedScale.toFixed(2)}×</strong></span>
				<span>Targets <strong>${variant.targetCount}</strong></span>
				<span>Travel <strong>${variant.travel.toFixed(2)}</strong></span>
				<span>Margin misses <strong>${variant.paddedBreaches}</strong></span>
			</div>`;
		section.querySelector("h2").textContent = variant.label;
		section.querySelector("p").textContent = variant.description;
		comparisonElement.append(section);
		const canvas = section.querySelector("canvas");
		const context = canvas.getContext("2d", { alpha: false, desynchronized: true });
		return { section, canvas, context };
	});
}

function rebuildClickTrack() {
	clickTrack.replaceChildren();
	const span = comparison.window.endMs - comparison.window.startMs;
	for (const click of comparison.clicks) {
		const button = document.createElement("button");
		button.type = "button";
		button.className = "click-dot";
		button.style.left = `${((click.timeMs - comparison.window.startMs) / span) * 100}%`;
		button.title = `Click at ${formatTime(click.timeMs / 1_000)}`;
		button.addEventListener("click", () => {
			video.currentTime = click.timeMs / 1_000;
			render();
		});
		clickTrack.append(button);
	}
}

function rebuildComparison({ resetTime = false } = {}) {
	const chain = selectedChain();
	const policy = policyFromControls();
	updateOutputs();
	comparison = buildLabComparison(data.samples, chain, policy);
	document.querySelector("#click-count").textContent =
		`${comparison.clicks.length} clicks · ${(chain.durationMs / 1_000).toFixed(1)} s`;
	scrubber.min = String(comparison.window.startMs / 1_000);
	scrubber.max = String(comparison.window.endMs / 1_000);
	rebuildClickTrack();
	rebuildPanels();
	if (
		resetTime ||
		video.currentTime * 1_000 < comparison.window.startMs ||
		video.currentTime * 1_000 > comparison.window.endMs
	) {
		video.currentTime = comparison.window.startMs / 1_000;
	}
	render();
}

for (const chain of data.chains) {
	const option = document.createElement("option");
	option.value = chain.id;
	option.textContent = `${chain.clicks.length} clicks · ${formatTime(chain.startMs / 1_000)}`;
	chainSelect.append(option);
}
chainSelect.value = data.defaultChainId;

playButton.addEventListener("click", async () => {
	if (!comparison) return;
	if (video.paused) {
		if (video.currentTime * 1_000 >= comparison.window.endMs)
			video.currentTime = comparison.window.startMs / 1_000;
		await video.play();
	} else {
		video.pause();
	}
});
video.addEventListener("play", () => {
	playButton.textContent = "Pause";
	render();
	startAnimationLoop();
});
video.addEventListener("pause", () => {
	playButton.textContent = "Play";
	if (frameRequest) cancelAnimationFrame(frameRequest);
	frameRequest = 0;
	if (video.ended && loopInput.checked && comparison) return;
	render();
});
video.addEventListener("ended", () => {
	if (!loopInput.checked || !comparison) {
		render();
		return;
	}
	video.currentTime = comparison.window.startMs / 1_000;
	void video.play();
});
video.addEventListener("seeked", render);
scrubber.addEventListener("input", () => {
	video.currentTime = Number(scrubber.value);
	render();
});
chainSelect.addEventListener("change", () => rebuildComparison({ resetTime: true }));
for (const input of Object.values(inputs))
	input.addEventListener("input", () => rebuildComparison());
window.addEventListener("resize", render);

video.src = "./video";
video.addEventListener(
	"loadedmetadata",
	() => {
		rebuildComparison({ resetTime: true });
		playButton.disabled = false;
	},
	{ once: true },
);
