import { useEffect, useState } from "react";
import { toast } from "sonner";
import type { EntitlementSnapshot } from "@/lib/entitlements/contracts";

const NOTICE_STORAGE_KEY = "klippt.trialStartNotice";

type NoticeInput = {
	snapshot: Pick<EntitlementSnapshot, "status" | "trialStartedAt">;
	hasRecording: boolean;
	visible: boolean;
	shownForTrial: string | null;
};

/** Once per trial, on the first visible review of a recording after it started. */
export function shouldShowTrialStartNotice({
	snapshot,
	hasRecording,
	visible,
	shownForTrial,
}: NoticeInput): boolean {
	return (
		snapshot.status === "trial-active" &&
		Boolean(snapshot.trialStartedAt) &&
		snapshot.trialStartedAt !== shownForTrial &&
		hasRecording &&
		visible
	);
}

function readShownTrial(): string | null {
	try {
		return window.localStorage.getItem(NOTICE_STORAGE_KEY);
	} catch {
		return null;
	}
}

function rememberShownTrial(trialStartedAt: string): void {
	try {
		window.localStorage.setItem(NOTICE_STORAGE_KEY, trialStartedAt);
	} catch {
		// Without storage the notice can repeat; it never blocks review.
	}
}

export function useTrialStartNotice(
	snapshot: EntitlementSnapshot,
	hasRecording: boolean,
	message: string,
): void {
	const [visible, setVisible] = useState(() => document.visibilityState === "visible");

	useEffect(() => {
		const update = () => setVisible(document.visibilityState === "visible");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);

	useEffect(() => {
		const trialStartedAt = snapshot.trialStartedAt;
		if (
			!trialStartedAt ||
			!shouldShowTrialStartNotice({
				snapshot,
				hasRecording,
				visible,
				shownForTrial: readShownTrial(),
			})
		) {
			return;
		}
		rememberShownTrial(trialStartedAt);
		toast.success(message, { id: "trial-started" });
	}, [snapshot, hasRecording, visible, message]);
}
