import { RotateCcw, Scissors } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import type { ReviewCut } from "@/lib/cleanCut/reviewModel";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import { formatRemoved } from "./labels";
import { removedSecOf } from "./moments";
import styles from "./PausesRow.module.css";

/**
 * The pauses the clean cut lifts out, as one line with their time, so the cuts and the
 * pauses add up to the runtime saved. One button brings every pause back, or cuts them again.
 */
export function PausesRow({ pauses }: { pauses: readonly ReviewCut[] }) {
	const t = useScopedT("editor");
	if (pauses.length === 0) return null;
	const allRestored = pauses.every((pause) => pause.restored);
	const removed = removedSecOf(pauses);
	return (
		<div className={styles.row} data-testid="clean-cut-pauses">
			<span className={styles.tick} aria-hidden="true" />
			<span className={styles.label}>{t("cleanCut.pauses")}</span>
			<span className={styles.count}>{pauses.length}</span>
			<span className={styles.removed}>
				{allRestored ? t("cleanCut.restored") : formatRemoved(removed)}
			</span>
			<span className={styles.spacer} />
			<button
				type="button"
				className={styles.action}
				onClick={() =>
					useCleanCutStore.getState().setRestoredMany(
						pauses.map((pause) => pause.region.id),
						!allRestored,
					)
				}
			>
				{allRestored ? (
					<Scissors size={13} aria-hidden="true" />
				) : (
					<RotateCcw size={13} aria-hidden="true" />
				)}
				{allRestored ? t("cleanCut.cutPausesAgain") : t("cleanCut.restoreAllPauses")}
			</button>
		</div>
	);
}
