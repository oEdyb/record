import { Info } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import { getCleanCutBridge } from "@/lib/cleanCut/bridge";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import type { CleanCutModelCheck } from "@/lib/cleanCut/types";
import styles from "./BasicCutNotice.module.css";

/** A rules-only cut: the Claude check did not run, so it finds fewer retakes. */
export function isBasicCut(modelCheck: CleanCutModelCheck | null): boolean {
	return modelCheck === "off" || modelCheck === "unavailable" || modelCheck === "failed";
}

async function chooseClaudeCheck(enabled: boolean) {
	await getCleanCutBridge()?.setClaudeCheck(enabled);
	useCleanCutStore.getState().retry();
}

/**
 * Says plainly where the recording's words went. By default the cut is made on this computer.
 * Turning the Claude check on is the only way the transcript text leaves it, and the notice names
 * that before the person clicks and again after it happened.
 */
export function BasicCutNotice({ modelCheck }: { modelCheck: CleanCutModelCheck | null }) {
	const t = useScopedT("editor");
	if (modelCheck === null) return null;
	const message =
		modelCheck === "off"
			? t("cleanCut.offNotice")
			: modelCheck === "done"
				? t("cleanCut.claudeCheckedNotice")
				: t("cleanCut.basicNotice");
	return (
		<p className={styles.notice} data-testid="clean-cut-basic">
			<Info size={14} aria-hidden="true" className={styles.icon} />
			<span className={styles.text}>{message}</span>
			{modelCheck === "failed" ? (
				<button
					type="button"
					className={styles.retry}
					onClick={() => useCleanCutStore.getState().retry()}
				>
					{t("cleanCut.retry")}
				</button>
			) : null}
			<button
				type="button"
				className={styles.retry}
				onClick={() => void chooseClaudeCheck(modelCheck === "off")}
			>
				{modelCheck === "off" ? t("cleanCut.sendTranscript") : t("cleanCut.turnOffClaude")}
			</button>
		</p>
	);
}
