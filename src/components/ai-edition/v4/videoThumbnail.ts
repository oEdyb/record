import { toFileUrl } from "@/components/video-editor/projectPersistence";

const thumbnails = new Map<string, string>();
const queue: Array<() => void> = [];
let active = 0;

function runNext() {
	while (active < 2 && queue.length) queue.shift()?.();
}

export function videoThumbnail(
	path: string,
	timeSec: number,
	signal: AbortSignal,
): Promise<string | null> {
	const key = JSON.stringify([path, timeSec]);
	const cached = thumbnails.get(key);
	if (cached) return Promise.resolve(cached);
	return new Promise((resolve) => {
		const start = () => {
			if (signal.aborted) {
				resolve(null);
				return;
			}
			active++;
			const video = document.createElement("video");
			let settled = false;
			const finish = (image: string | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				signal.removeEventListener("abort", abort);
				video.onloadedmetadata = null;
				video.onloadeddata = null;
				video.onseeked = null;
				video.onerror = null;
				video.removeAttribute("src");
				video.load();
				if (image) {
					thumbnails.set(key, image);
					if (thumbnails.size > 128) {
						const oldest = thumbnails.keys().next().value;
						if (oldest) thumbnails.delete(oldest);
					}
				}
				active--;
				resolve(image);
				runNext();
			};
			const abort = () => finish(null);
			const timeout = setTimeout(abort, 8_000);
			const capture = () => {
				if (video.seeking || video.readyState < 2) return;
				try {
					const canvas = document.createElement("canvas");
					const scale = 240 / Math.max(video.videoWidth, video.videoHeight, 1);
					canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
					canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
					const context = canvas.getContext("2d");
					if (!context) {
						finish(null);
						return;
					}
					context.drawImage(video, 0, 0, canvas.width, canvas.height);
					finish(canvas.toDataURL("image/jpeg", 0.7));
				} catch {
					finish(null);
				}
			};
			video.muted = true;
			video.preload = "auto";
			video.onloadedmetadata = () => {
				const end = Number.isFinite(video.duration) ? Math.max(0, video.duration - 0.05) : timeSec;
				video.currentTime = Math.max(0, Math.min(timeSec, end));
			};
			video.onloadeddata = capture;
			video.onseeked = capture;
			video.onerror = abort;
			signal.addEventListener("abort", abort, { once: true });
			video.src = toFileUrl(path);
		};
		queue.push(start);
		runNext();
	});
}
