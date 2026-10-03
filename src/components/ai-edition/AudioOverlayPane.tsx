import { useState } from "react";
import { z } from "zod";
import { InspectorActionButton } from "@/components/ui/inspector";
import { createId } from "@/lib/ai-edition/document/ids";
import { documentSchema } from "@/lib/ai-edition/schema";
import {
	type AudioClip,
	audioAssetSchema,
	audioClipSchema,
} from "@/lib/ai-edition/schema/audioOverlays";
import { getProjectMutationGeneration, useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { nativeBridgeClient } from "@/native/client";
import styles from "./AudioOverlayPane.module.css";

const fields = [
	["startSec", "Start (s)"],
	["endSec", "End (s)"],
	["sourceOffsetSec", "Source offset (s)"],
	["gain", "Volume multiplier"],
	["fadeInSec", "Fade in (s)"],
	["fadeOutSec", "Fade out (s)"],
] as const;

function AudioClipEditor({
	clip,
	label,
	disabled,
	save,
	remove,
}: {
	clip: AudioClip;
	label: string;
	disabled: boolean;
	save: (clip: AudioClip) => Promise<void>;
	remove: () => Promise<void>;
}) {
	const [draft, setDraft] = useState(clip);
	return (
		<form
			className={styles.clip}
			onSubmit={(event) => {
				event.preventDefault();
				void save(draft);
			}}
		>
			<strong className={styles.label}>{label}</strong>
			<div className={styles.fields}>
				{fields.map(([key, title]) => (
					<label key={key} className={styles.label}>
						{title}
						<input
							className={styles.input}
							type="number"
							min={0}
							max={key === "gain" ? 4 : 10800}
							step="0.01"
							required
							value={Number.isFinite(draft[key]) ? draft[key] : ""}
							disabled={disabled}
							onChange={(event) => setDraft({ ...draft, [key]: event.currentTarget.valueAsNumber })}
						/>
					</label>
				))}
			</div>
			<div className={styles.actions}>
				<InspectorActionButton type="submit" disabled={disabled}>
					Apply audio edit
				</InspectorActionButton>
				<button type="button" disabled={disabled} onClick={() => void remove()}>
					Remove audio
				</button>
			</div>
		</form>
	);
}

/** Clips use output seconds. Video edits never move these placements implicitly. */
export function AudioOverlayPane() {
	const document = useProjectStore((state) => state.document);
	const revision = useProjectStore((state) => state.revision);
	const blocked = useProjectStore((state) => state.transactionBusy || state.transactionSyncPending);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	async function run(work: () => Promise<void>) {
		if (busy || blocked) return;
		setBusy(true);
		setError(null);
		try {
			await work();
		} catch (cause) {
			setError(
				cause instanceof z.ZodError
					? (cause.issues[0]?.message ?? "Invalid audio edit")
					: cause instanceof Error
						? cause.message
						: String(cause),
			);
		} finally {
			setBusy(false);
		}
	}
	async function add() {
		await run(async () => {
			const base = useProjectStore.getState();
			if (!base.document || !base.projectId) throw new Error("Open a project first");
			const generation = getProjectMutationGeneration(base.projectId);
			const result = await nativeBridgeClient.aiEdition.pickAudioAsset(base.projectId);
			if (result.canceled) return;
			const asset = audioAssetSchema.parse(result.asset);
			const current = useProjectStore.getState();
			if (
				current.projectId !== base.projectId ||
				current.revision !== base.revision ||
				getProjectMutationGeneration(base.projectId) !== generation
			)
				throw new Error("The project changed during audio import. Try again.");
			const startSec = Math.min(Math.max(0, base.currentTimeSec), 10799.999);
			const clip = audioClipSchema.parse({
				id: createId("audio_clip"),
				assetId: asset.id,
				startSec,
				endSec: Math.min(10800, startSec + asset.durationSec),
				sourceOffsetSec: 0,
				gain: 1,
				fadeInSec: 0,
				fadeOutSec: 0,
			});
			const next = documentSchema.parse({
				...base.document,
				audioAssets: [...(base.document.audioAssets ?? []), asset],
				timeline: {
					...base.document.timeline,
					audioClips: [...(base.document.timeline.audioClips ?? []), clip],
				},
			});
			if (!(await current.saveDocumentAsEdit(next))) throw new Error("Audio import was not saved");
		});
	}
	async function edit(clipId: string, replacement?: AudioClip) {
		await run(async () => {
			const state = useProjectStore.getState();
			if (
				!state.document ||
				state.document.project.id !== document?.project.id ||
				state.revision !== revision
			)
				throw new Error("The project changed. Review the current audio edit.");
			const clips = state.document.timeline.audioClips ?? [];
			const nextClips = replacement
				? clips.map((clip) => (clip.id === clipId ? audioClipSchema.parse(replacement) : clip))
				: clips.filter((clip) => clip.id !== clipId);
			const next = documentSchema.parse({
				...state.document,
				audioAssets: replacement
					? state.document.audioAssets
					: state.document.audioAssets?.filter(
							(asset) =>
								asset.id !== clips.find((clip) => clip.id === clipId)?.assetId ||
								nextClips.some((clip) => clip.assetId === asset.id),
						),
				timeline: { ...state.document.timeline, audioClips: nextClips },
			});
			if (!(await state.saveDocumentAsEdit(next))) throw new Error("Audio edit was not saved");
		});
	}
	return (
		<section className={styles.section} aria-label="Added audio">
			<div className={styles.header}>
				<InspectorActionButton
					type="button"
					disabled={!document || busy || blocked}
					onClick={() => void add()}
				>
					{busy ? "Saving audio…" : "Add audio file"}
				</InspectorActionButton>
			</div>
			<p className={styles.hint}>
				Add music or sound effects at the playhead. Their position stays fixed when you cut the
				video.
			</p>
			{error && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			{document?.timeline.audioClips?.map((clip) => (
				<AudioClipEditor
					key={`${document.project.id}:${revision}:${clip.id}`}
					clip={clip}
					label={document.audioAssets?.find((asset) => asset.id === clip.assetId)?.label ?? "Audio"}
					disabled={busy || blocked}
					save={(next) => edit(clip.id, next)}
					remove={() => edit(clip.id)}
				/>
			))}
		</section>
	);
}
