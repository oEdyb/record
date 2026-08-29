// Hidden-window runner for `klippt captions`: transcribes the project's
// audio with the local speech model and writes the resulting caption
// annotations back into the project. Mirrors VideoEditor.generateAutoCaptions.

import { useEffect, useRef, useState } from "react";
import {
	normalizeProjectEditor,
	resolveProjectMedia,
	validateProjectData,
} from "@/components/video-editor/projectPersistence";
import type { AnnotationRegion } from "@/components/video-editor/types";
import { captionSegmentsFromTranscript, type SttRendererStatus } from "@/lib/captioning/transcribe";
import type { CliCaptionsRequest, CliDoneResult } from "@/lib/cliContracts";
import { nativeBridgeClient } from "@/native";
import { captionSegmentsToAnnotationRegions } from "./captionAnnotations";

/** Highest trailing number across existing region ids, so new ids never collide. */
function nextNumericIdFrom(regions: { id: string }[]): number {
	let max = 0;
	for (const region of regions) {
		const match = /(\d+)$/.exec(region.id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max + 1;
}

async function runCaptions(request: CliCaptionsRequest): Promise<CliDoneResult> {
	const loaded = await nativeBridgeClient.project.loadProjectFileFromPath(request.projectPath);
	if (!loaded.success || loaded.project === undefined) {
		throw new Error(loaded.error ?? loaded.message ?? "Failed to load project file");
	}
	if (!validateProjectData(loaded.project)) {
		throw new Error("Project file is not a valid Klippt project");
	}
	const project = loaded.project;
	const media = resolveProjectMedia(project);
	if (!media) {
		throw new Error("Project file does not reference any recorded media");
	}
	const editor = normalizeProjectEditor(project.editor ?? {});

	// Status fires once per transcribed chunk, not once per phase, so log
	// only on a phase change — otherwise a long transcription spams the CLI with
	// one identical line per chunk.
	let loggedPhase: SttRendererStatus["phase"] | null = null;
	const unsubscribe = window.electronAPI.stt.onStatus?.(({ phase }: SttRendererStatus) => {
		if (phase === loggedPhase) return;
		loggedPhase = phase;
		window.electronAPI.cliLog(
			"info",
			phase === "model" ? "Loading caption model…" : "Transcribing…",
		);
	});
	window.electronAPI.cliLog("info", "Inspecting audio…");
	let transcript;
	try {
		transcript = await window.electronAPI.stt.transcribeSource({
			sourcePath: media.screenVideoPath,
			sourceKind: "import",
		});
	} finally {
		unsubscribe?.();
	}
	const { segments, granularity } = captionSegmentsFromTranscript(transcript);

	// Re-running the command replaces earlier auto-captions instead of stacking
	// duplicates; manually added annotations are preserved.
	const manualAnnotations: AnnotationRegion[] = editor.annotationRegions.filter(
		(annotation) => annotation.annotationSource !== "auto-caption",
	);
	const startNumericId = nextNumericIdFrom([...editor.annotationRegions, ...editor.zoomRegions]);
	const startZIndex = manualAnnotations.reduce((max, a) => Math.max(max, a.zIndex + 1), 1);

	let regions = captionSegmentsToAnnotationRegions(segments, startNumericId, startZIndex, {
		minWordsPerCaption: request.minWordsPerCaption,
		maxWordsPerCaption: request.maxWordsPerCaption,
		timestampGranularity: granularity,
	});
	if (regions.length === 0 && segments.length > 0) {
		regions = captionSegmentsToAnnotationRegions(segments, startNumericId, startZIndex, {
			minWordsPerCaption: 1,
			maxWordsPerCaption: Number.MAX_SAFE_INTEGER,
			timestampGranularity: granularity,
		});
	}
	if (regions.length === 0) {
		throw new Error("Transcription produced no caption segments");
	}

	const updatedProject = {
		...project,
		editor: {
			...editor,
			annotationRegions: [...manualAnnotations, ...regions],
		},
	};

	return {
		success: true,
		projectPath: request.projectPath,
		projectData: updatedProject,
		captionCount: regions.length,
	};
}

export function CliCaptionsRunner() {
	const startedRef = useRef(false);
	const [status] = useState("Generating captions…");

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;

		void (async () => {
			try {
				const request = await window.electronAPI.cliGetRequest();
				if (request.kind !== "captions") {
					throw new Error(`cli-captions window received a ${request.kind} request`);
				}
				const result = await runCaptions(request);
				await window.electronAPI.cliDone(result);
			} catch (error) {
				const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
				await window.electronAPI.cliDone({ success: false, error: message });
			}
		})();
	}, []);

	return (
		<div className="flex h-screen items-center justify-center bg-[#09090b] text-white/60 text-sm">
			{status}
		</div>
	);
}

export default CliCaptionsRunner;
