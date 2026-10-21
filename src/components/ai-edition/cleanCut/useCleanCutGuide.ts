import { useEffect, useRef, useState } from "react";
import type { CleanCutReviewModel, ReviewCut } from "@/lib/cleanCut/reviewModel";
import { useCleanCutStore } from "@/lib/cleanCut/store";

export type ListenMode = "with" | "without";

export type PipState = "todo" | "current" | "kept" | "restored";

/** How long "Restored · Undo" stays on the card. */
export const RESTORED_FLASH_MS = 4000;

export interface CleanCutGuide {
	/** The cut on the card, or null on the summary. */
	current: ReviewCut | null;
	/** Position among the unsure cuts, or -1 for a cut picked from the full list. */
	index: number;
	queue: readonly ReviewCut[];
	pips: PipState[];
	finished: boolean;
	direction: -1 | 1;
	listen: ListenMode;
	/** The card replays its cut over and over until L, Esc or another cut. */
	looping: boolean;
	/** The cut just restored from the card, while "Restored · Undo" shows. */
	flashId: string | null;
	checkedCount: number;
	restoredCount: number;
	/** Unsure cuts not yet kept or restored. */
	uncheckedCount: number;
	keep: () => void;
	/** Restores the cut and plays it back in; the card stays until Return. */
	restore: () => void;
	undoRestore: () => void;
	step: (direction: -1 | 1) => void;
	/** Shows the unsure cut at this place in the queue, as a click on its pip does. */
	jump: (index: number) => void;
	/** Shows the first unsure cut still to check. */
	checkNext: () => void;
	setListen: (mode: ListenMode) => void;
	/** Plays the card's cut once more, the way it is set to listen. */
	replay: () => void;
	toggleLoop: () => void;
	/** Ends the loop where it is, as when the viewer takes the playhead elsewhere. */
	endLoop: () => void;
	/** Shows any cut on the card, picked from the play bar or the sheet, and plays it. */
	show: (cut: ReviewCut) => void;
}

interface GuideOptions {
	model: CleanCutReviewModel | null;
	/** Changes whenever a new analysis arrives, which clears what was checked. */
	resetKey: string;
	/** The card is in sight: not minimised, not behind the sheet, not in the small player. */
	active: boolean;
	select: (cut: ReviewCut) => void;
	audition: (cut: ReviewCut, mode: ListenMode, loop: boolean) => void;
	/** Stops a replay or a loop where it is. */
	stop: () => void;
}

/**
 * Walks the unsure cuts one at a time. Keep cut decides the card and moves on; Restore
 * plays the cut back in and leaves the card up until Return. Past the last one the card
 * becomes the summary. Selection stays in the store, so the full list, undo and the card
 * always agree on which cut is in front.
 */
export function useCleanCutGuide({
	model,
	resetKey,
	active,
	select,
	audition: play,
	stop,
}: GuideOptions): CleanCutGuide {
	const selectedId = useCleanCutStore((s) => s.selectedId);
	const toggleRestore = useCleanCutStore((s) => s.toggleRestore);
	const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
	const [finishedOn, setFinishedOn] = useState<string | null | undefined>(undefined);
	const [direction, setDirection] = useState<-1 | 1>(1);
	const [listen, setListenState] = useState<ListenMode>("without");
	const [looping, setLooping] = useState(false);
	const [flash, setFlash] = useState<string | null>(null);
	const heardRef = useRef(false);

	// biome-ignore lint/correctness/useExhaustiveDependencies: a new analysis starts a new walk.
	useEffect(() => {
		setChecked(new Set());
		setFinishedOn(undefined);
		setListenState("without");
		setLooping(false);
		setFlash(null);
		heardRef.current = false;
	}, [resetKey]);

	useEffect(() => {
		if (!flash) return;
		const timer = setTimeout(() => setFlash(null), RESTORED_FLASH_MS);
		return () => clearTimeout(timer);
	}, [flash]);

	const audition = (cut: ReviewCut, mode: ListenMode, loop: boolean) => {
		heardRef.current = true;
		play(cut, mode, loop);
	};

	const queue = model ? model.cuts.slice(0, model.unsureCount) : [];
	const index = queue.findIndex((cut) => cut.region.id === selectedId);
	const picked = model?.cuts.find((cut) => cut.region.id === selectedId) ?? null;
	const finished =
		model !== null &&
		(queue.length === 0 || (finishedOn !== undefined && finishedOn === selectedId));
	const current = finished ? null : picked;

	const firstId = queue[0]?.region.id;
	const lost = model !== null && picked === null;
	const lastAtRef = useRef(0);
	if (picked) lastAtRef.current = picked.rawStartSec;
	// The card always holds a cut: the first unsure one at the start, and the next unchecked
	// one when a strength change drops the cut it was on.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only these changes move the card.
	useEffect(() => {
		if (!model || !lost || !queue[0]) return;
		const open = queue.filter((cut) => !checked.has(cut.region.id));
		select(open.find((cut) => cut.rawStartSec >= lastAtRef.current) ?? open[0] ?? queue[0]);
	}, [model !== null, firstId, lost]);

	// The first card plays as soon as it is in sight, so the review never opens silent.
	// biome-ignore lint/correctness/useExhaustiveDependencies: once per walk, when first seen.
	useEffect(() => {
		if (!active || !current || heardRef.current) return;
		audition(current, "without", false);
	}, [active, current?.region.id]);

	const leaveCut = () => {
		setFlash(null);
		if (looping) {
			setLooping(false);
			stop();
		}
	};
	const goTo = (cut: ReviewCut, dir: -1 | 1) => {
		setLooping(false);
		setFlash(null);
		setDirection(dir);
		setListenState("without");
		setFinishedOn(undefined);
		select(cut);
		audition(cut, "without", false);
	};
	const advance = (decidedId: string) => {
		const from = Math.max(index, -1);
		const next =
			queue
				.slice(from + 1)
				.find((cut) => !checked.has(cut.region.id) && cut.region.id !== decidedId) ??
			queue.find((cut) => !checked.has(cut.region.id) && cut.region.id !== decidedId);
		if (next) goTo(next, 1);
		else {
			leaveCut();
			setDirection(1);
			setFinishedOn(selectedId);
		}
	};
	const decide = (id: string) => setChecked((prev) => new Set(prev).add(id));
	const undecide = (id: string) =>
		setChecked((prev) => {
			const next = new Set(prev);
			next.delete(id);
			return next;
		});

	const pips: PipState[] = queue.map((cut) =>
		cut.region.id === current?.region.id
			? "current"
			: cut.restored
				? "restored"
				: checked.has(cut.region.id)
					? "kept"
					: "todo",
	);
	const open = queue.filter((cut) => !checked.has(cut.region.id) && !cut.restored);

	return {
		current,
		index,
		queue,
		pips,
		finished,
		direction,
		listen,
		looping: looping && current !== null,
		flashId: flash !== null && flash === current?.region.id ? flash : null,
		checkedCount: queue.length - open.length,
		restoredCount: queue.filter((cut) => cut.restored).length,
		uncheckedCount: open.length,
		keep: () => {
			if (!current) return;
			decide(current.region.id);
			advance(current.region.id);
		},
		restore: () => {
			if (!current) return;
			const id = current.region.id;
			toggleRestore(id);
			decide(id);
			const mode: ListenMode = current.restored ? "without" : "with";
			setFlash(current.restored ? null : id);
			setListenState(mode);
			audition(current, mode, looping);
		},
		undoRestore: () => {
			if (!current || flash !== current.region.id) return;
			const store = useCleanCutStore.getState();
			const last = store.undoSteps[store.undoSteps.length - 1];
			if (last?.type === "restore" && last.id === flash && last.restored) store.undo();
			else if (store.restored.has(flash)) store.toggleRestore(flash);
			undecide(flash);
			setFlash(null);
			setListenState("without");
			audition(current, "without", looping);
		},
		step: (dir) => {
			if (finished) {
				if (dir < 0 && queue.length > 0) {
					setDirection(-1);
					setFinishedOn(undefined);
					const last = queue[queue.length - 1];
					if (last.region.id !== selectedId) select(last);
				}
				return;
			}
			const next = index + dir;
			if (next >= queue.length) {
				leaveCut();
				setDirection(1);
				setFinishedOn(selectedId);
			} else if (next >= 0) goTo(queue[next], dir);
		},
		jump: (to) => {
			const cut = queue[to];
			if (cut && cut.region.id !== current?.region.id) goTo(cut, to >= index ? 1 : -1);
		},
		checkNext: () => {
			if (open[0]) goTo(open[0], 1);
		},
		show: (cut) => {
			if (cut.region.id !== current?.region.id) leaveCut();
			setListenState("without");
			setFinishedOn(undefined);
			setDirection(index === -1 || queue.indexOf(cut) >= index ? 1 : -1);
			select(cut);
			audition(cut, "without", false);
		},
		setListen: (mode) => {
			if (!current) return;
			setListenState(mode);
			audition(current, mode, looping);
		},
		replay: () => {
			if (current) audition(current, listen, looping);
		},
		toggleLoop: () => {
			if (!current) return;
			if (looping) {
				setLooping(false);
				stop();
				return;
			}
			setLooping(true);
			audition(current, listen, true);
		},
		endLoop: () => setLooping(false),
	};
}
