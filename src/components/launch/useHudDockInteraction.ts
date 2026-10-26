import { useCallback, useEffect, useReducer } from "react";
import { useLinuxHudGeometry } from "./useLinuxHudGeometry";

const OPEN_DELAY_MS = 120;
const CLOSE_DELAY_MS = 280;
export const HUD_DOCK_SETTLE_MS = 600;

type Options = { docked: boolean; dragging: boolean; panelOpen: boolean };
type Phase = "collapsed" | "opening" | "expanded" | "leaving" | "closing";
type State = Options & {
	phase: Phase;
	inside: boolean;
	focused: boolean;
	pinned: boolean;
	hoverBlocked: boolean;
};
type Action =
	| { type: "options"; options: Options }
	| { type: "pointer"; inside: boolean }
	| { type: "focus"; focused: boolean }
	| { type: "pin" }
	| { type: "collapse" }
	| { type: "elapsed"; phase: Phase };

function initialState(options: Options): State {
	return {
		...options,
		phase: options.docked && (options.dragging || options.panelOpen) ? "expanded" : "collapsed",
		inside: false,
		focused: false,
		pinned: false,
		hoverBlocked: false,
	};
}

function held(state: State) {
	return state.inside || state.focused || state.pinned || state.panelOpen || state.dragging;
}

function release(state: State): State {
	if (held(state)) return state;
	if (state.phase === "opening") return { ...state, phase: "collapsed" };
	if (state.phase === "expanded") return { ...state, phase: "leaving" };
	return state;
}

function collapse(state: State): State {
	return { ...state, phase: "closing", pinned: false, focused: false, hoverBlocked: state.inside };
}

function reduce(state: State, action: Action): State {
	if (action.type === "options") {
		const { options } = action;
		if (!options.docked || !state.docked) return initialState(options);
		const next = { ...state, ...options };
		if ((!state.dragging && options.dragging) || (!state.panelOpen && options.panelOpen)) {
			return { ...next, phase: "expanded", hoverBlocked: false };
		}
		return release(next);
	}
	if (!state.docked) return state;
	switch (action.type) {
		case "pointer": {
			if (state.inside === action.inside) return state;
			const next = { ...state, inside: action.inside };
			if (!action.inside) {
				// A spring can briefly shrink past a stationary cursor. Keep an explicit
				// collapse latched until its geometry settles before accepting re-entry.
				return release({
					...next,
					hoverBlocked: state.phase === "closing" && state.hoverBlocked,
				});
			}
			if (state.hoverBlocked) return next;
			return {
				...next,
				phase: state.phase === "collapsed" ? "opening" : "expanded",
			};
		}
		case "focus": {
			if (state.focused === action.focused) return state;
			const next = { ...state, focused: action.focused };
			return action.focused ? { ...next, phase: "expanded", hoverBlocked: false } : release(next);
		}
		case "pin":
			return state.pinned
				? collapse(state)
				: { ...state, pinned: true, phase: "expanded", hoverBlocked: false };
		case "collapse":
			return collapse(state);
		case "elapsed":
			if (state.phase !== action.phase) return state;
			if (state.phase === "opening") return { ...state, phase: "expanded" };
			if (state.phase === "leaving") return { ...state, phase: "closing" };
			if (state.phase === "closing") {
				return { ...state, phase: "collapsed", hoverBlocked: state.hoverBlocked && state.inside };
			}
			return state;
	}
}

export function useHudDockInteraction({
	docked,
	dragging,
	panelOpen,
	closeDurationMs = HUD_DOCK_SETTLE_MS,
}: Options & { closeDurationMs?: number }) {
	useLinuxHudGeometry();
	const [state, dispatch] = useReducer(reduce, { docked, dragging, panelOpen }, initialState);

	useEffect(() => {
		dispatch({ type: "options", options: { docked, dragging, panelOpen } });
	}, [docked, dragging, panelOpen]);

	useEffect(() => {
		const phase = state.phase;
		const delay =
			phase === "opening"
				? OPEN_DELAY_MS
				: phase === "leaving"
					? CLOSE_DELAY_MS
					: phase === "closing"
						? closeDurationMs
						: null;
		if (delay === null) return;
		const timer = window.setTimeout(() => dispatch({ type: "elapsed", phase }), delay);
		return () => window.clearTimeout(timer);
	}, [state.phase, closeDurationMs]);

	const samplePointer = useCallback((inside: boolean) => dispatch({ type: "pointer", inside }), []);
	const setFocusWithin = useCallback(
		(focused: boolean) => dispatch({ type: "focus", focused }),
		[],
	);
	const togglePinned = useCallback(() => dispatch({ type: "pin" }), []);
	const collapseDock = useCallback(() => dispatch({ type: "collapse" }), []);

	return {
		expanded: docked && (state.phase === "expanded" || state.phase === "leaving"),
		pinned: docked && state.pinned,
		samplePointer,
		setFocusWithin,
		togglePinned,
		collapse: collapseDock,
	};
}
