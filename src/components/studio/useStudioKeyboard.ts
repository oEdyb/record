import { useEffect } from "react";
import type { StudioLayout } from "@/lib/userPreferences";
import type { StudioCommand, StudioSnapshot } from "../../../electron/studio/types";
import { sentenceTarget, studioKeyAllowed } from "./studioLayout";

export function useStudioKeyboard({
	snapshot,
	layout,
	update,
	send,
	position,
	sentences,
	clips,
	seek,
	play,
	follow,
	resizeText,
	changeSpeed,
	toggleMeters,
	help,
	blocked,
}: {
	snapshot: StudioSnapshot | null;
	layout: StudioLayout;
	update: (patch: Partial<StudioLayout>) => void;
	send: (command: StudioCommand) => void;
	position: number;
	sentences: number[];
	clips: number[];
	seek: (value: number, play?: boolean) => void;
	play: () => void;
	follow: () => void;
	resizeText: (delta: number) => void;
	changeSpeed: (delta: number) => void;
	toggleMeters: () => void;
	help: () => void;
	blocked: boolean;
}) {
	useEffect(() => {
		const key = (event: KeyboardEvent) => {
			if (!snapshot || blocked || !layout.shortcuts || !studioKeyAllowed(event, event.target))
				return;
			const replay = snapshot.phase === "paused" || snapshot.phase === "review";
			const action = (() => {
				if (event.key === "?") return help;
				if (event.key === "m")
					return () =>
						update({
							liveMode: LIVE_MODES[(LIVE_MODES.indexOf(layout.liveMode) + 1) % LIVE_MODES.length],
						});
				if (event.key === "v") return toggleMeters;
				if (event.key === "g" && snapshot.phase === "idle")
					return () => update({ guides: !layout.guides });
				if (!replay) return null;
				switch (event.key) {
					case " ":
						return play;
					case "ArrowLeft":
						return () => seek(position - (event.shiftKey ? 10 : 5));
					case "ArrowRight":
						return () => seek(position + (event.shiftKey ? 10 : 5));
					case "Home":
						return () => seek(0);
					case "End":
						return () => seek(snapshot.committedMs / 1000);
					case "ArrowUp":
					case "ArrowDown":
						return () => {
							const target = sentenceTarget(
								sentences,
								position,
								event.key === "ArrowDown" ? 1 : -1,
							);
							if (target !== null) seek(target);
						};
					case "Enter":
						return () => {
							const target = [...sentences].reverse().find((t) => t <= position) ?? sentences[0];
							if (target !== undefined) seek(target, true);
						};
					case "[":
					case "]":
						return () => {
							const target = sentenceTarget(clips, position, event.key === "]" ? 1 : -1);
							if (target !== null) seek(target);
						};
					case "t":
						return () => update({ dock: layout.dock === "left" ? "right" : "left" });
					case "f":
						return follow;
					case "-":
						return () => resizeText(-1);
					case "=":
						return () => resizeText(1);
					case ",":
						return () => changeSpeed(-0.25);
					case ".":
						return () => changeSpeed(0.25);
					case "Backspace":
						return snapshot.pill.canRemovePreviousClip && !snapshot.pill.transportBusy
							? () => send("remove-last")
							: null;
					default: {
						const index = Number(event.key) - 1;
						return /^[1-9]$/.test(event.key) && clips[index] !== undefined
							? () => seek(clips[index])
							: null;
					}
				}
			})();
			if (action) {
				event.preventDefault();
				action();
			}
		};
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	});
}

const LIVE_MODES = ["both", "notes", "mirror", "nothing"] as const;
