import { useEffect, useState } from "react";
import { portalOwnsSourceSelection } from "@/lib/nativeLinuxRecording";

/**
 * Whether the ScreenCast portal — not the app — chooses what gets recorded.
 *
 * THE SINGLE SOURCE OF TRUTH FOR EVERY SOURCE-PICKER SURFACE. There is more than
 * one way into a recording (the HUD, and the editor's Rec stage), and each one
 * used to answer this question for itself. They disagreed: the HUD dropped its
 * picker on Linux while the Rec stage kept opening one, so the same build both
 * hid the choice and demanded it depending on where you started from.
 *
 * `false` until the answer arrives, so a surface renders its picker by default
 * and only withdraws it once Linux + a working PipeWire helper are confirmed.
 * The wrong way round would flash a picker on every platform.
 *
 * @see portalOwnsSourceSelection for why the answer cannot be `platform === "linux"`.
 */
export function usePortalSourceState(): { ownsSource: boolean; ready: boolean } {
	const [portalOwnsSource, setPortalOwnsSource] = useState(false);
	const [ready, setReady] = useState(false);

	useEffect(() => {
		let cancelled = false;

		void (async () => {
			if (!window.electronAPI) {
				return;
			}
			try {
				const owns = await portalOwnsSourceSelection(window.electronAPI);
				if (!cancelled) setPortalOwnsSource(owns);
			} finally {
				if (!cancelled) setReady(true);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, []);

	return { ownsSource: portalOwnsSource, ready };
}

export function usePortalOwnsSource(): boolean {
	return usePortalSourceState().ownsSource;
}
