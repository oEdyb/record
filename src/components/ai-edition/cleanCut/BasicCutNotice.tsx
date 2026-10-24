import { Info } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import type { CleanCutModelCheck } from "@/lib/cleanCut/types";
import styles from "./BasicCutNotice.module.css";

/** A rules-only cut: the AI check did not run, so it finds fewer retakes. */
export function isBasicCut(modelCheck: CleanCutModelCheck | null): boolean {
	return modelCheck === "unavailable" || modelCheck === "failed";
}

/**
 * Says plainly when the AI did not check the recording. When its calls failed, Try again
 * runs Clean cut once more; when it is not installed there is nothing to retry.
 */
export function BasicCutNotice({ modelCheck }: { modelCheck: CleanCutModelCheck | null }) {
	const t = useScopedT("editor");
	if (!isBasicCut(modelCheck)) return null;
	return (
		<p className={styles.notice} data-testid="clean-cut-basic">
			<Info size={14} aria-hidden="true" className={styles.icon} />
			<span className={styles.text}>{t("cleanCut.basicNotice")}</span>
			{modelCheck === "failed" ? (
				<button
					type="button"
					className={styles.retry}
					onClick={() => useCleanCutStore.getState().retry()}
				>
					{t("cleanCut.retry")}
				</button>
			) : null}
		</p>
	);
}
