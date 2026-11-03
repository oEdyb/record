import { realpath } from "node:fs/promises";
import type { WebContents } from "electron";
import { resolvePlaybackSegments } from "../../src/lib/ai-edition/document/timeline";
import { documentSchema } from "../../src/lib/ai-edition/schema";
import { resolveClipSourceEndSec } from "../../src/lib/ai-edition/timeline/clipDuration";
import type { RendererIpcMain } from "../ipc/trustedRendererIpc";
import type { ClaudeCheckSetting } from "./claudeCheck";
import type { CleanCutMedia, CleanCutService } from "./service";

export interface CleanCutIpcDeps {
	service: CleanCutService;
	claudeCheck: Pick<ClaudeCheckSetting, "get" | "set">;
	resolveApprovedPath: (file: string) => string | null;
	/** Where snapshots go; the review window that started the run. */
	setReceiver: (receiver: WebContents | null) => void;
}

/** The recordings a project plays, in edit order, with the audio the engine should read. */
export async function cleanCutMedia(
	input: unknown,
	resolveApprovedPath: (file: string) => string | null,
) {
	const document = documentSchema.parse(input);
	const assetById = new Map(document.assets.map((asset) => [asset.id, asset]));
	const clips = [...document.timeline.clips]
		.sort((a, b) => a.timelineStartSec - b.timelineStartSec)
		.map((clip) => ({
			...clip,
			sourceEndSec: resolveClipSourceEndSec(clip, assetById.get(clip.assetId)),
		}));
	const segments = resolvePlaybackSegments(clips, document.timeline.trimRanges);
	const media: CleanCutMedia[] = [];
	for (const assetId of new Set(segments.map((segment) => segment.assetId))) {
		const asset = assetById.get(assetId);
		if (!asset) continue;
		const file = asset.microphoneAudioPath ?? asset.originalPath;
		const canonical = await realpath(file).catch(() => null);
		if (!canonical || !resolveApprovedPath(canonical))
			throw new Error("Open this recording with the file picker first.");
		media.push({
			assetId,
			audioPath: canonical,
			offsetSec: asset.microphoneAudioPath ? (asset.microphoneAudioOffsetMs ?? 0) / 1000 : 0,
		});
	}
	const rawDurationSec = segments.reduce(
		(sum, segment) => sum + (segment.timelineEndSec - segment.timelineStartSec),
		0,
	);
	return { projectId: document.project.id, media, rawDurationSec };
}

export function registerCleanCutIpc(ipcMain: RendererIpcMain, deps: CleanCutIpcDeps) {
	ipcMain.handle("clean-cut-start", async (event, payload: unknown) => {
		const request = (payload ?? {}) as { projectId?: unknown; document?: unknown };
		const { projectId, media, rawDurationSec } = await cleanCutMedia(
			request.document,
			deps.resolveApprovedPath,
		);
		if (typeof request.projectId === "string" && request.projectId !== projectId)
			throw new Error("The clean cut request does not match its project.");
		deps.setReceiver(event.sender);
		void deps.service.start(projectId, media, rawDurationSec);
	});
	ipcMain.handle("clean-cut-get-claude-check", () => deps.claudeCheck.get());
	ipcMain.handle("clean-cut-set-claude-check", async (_event, enabled: unknown) => {
		await deps.claudeCheck.set(enabled === true);
	});
	ipcMain.handle("clean-cut-cancel", async () => {
		deps.service.cancel();
	});
}
