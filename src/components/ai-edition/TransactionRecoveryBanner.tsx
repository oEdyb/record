import { useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import {
	reconcileProjectTransactions,
	resolveLocalTransactionConflict,
	useProjectStore,
} from "@/lib/ai-edition/store/projectStore";
import buttons from "./ReviewSurface.module.css";
import styles from "./TransactionRecoveryBanner.module.css";

/** Recovery is explicit: a conflict must never silently discard the live edit. */
export function TransactionRecoveryBanner() {
	const t = useScopedT("editor");
	const pending = useProjectStore((state) => state.transactionSyncPending);
	const error = useProjectStore((state) => state.error);
	const guarded = useProjectStore((state) => state.transactionVersion !== null);
	const busy = useProjectStore((state) => state.transactionBusy);
	const projectId = useProjectStore((state) => state.projectId);
	const [working, setWorking] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	if ((!pending && !(guarded && error)) || !projectId) return null;
	const recover = async (strategy: "check" | "save-copy" | "reload") => {
		setWorking(true);
		setMessage(null);
		try {
			if (strategy === "check") await reconcileProjectTransactions(projectId);
			else await resolveLocalTransactionConflict(strategy);
		} catch (error) {
			setMessage(error instanceof Error ? error.message : t("saveRecovery.failed"));
		} finally {
			setWorking(false);
		}
	};
	return (
		<section role="alert" aria-label={t("saveRecovery.label")} className={styles.banner}>
			<div className={styles.head}>
				<span className={styles.dot} aria-hidden="true" />
				<p className={styles.title}>{t("saveRecovery.title")}</p>
			</div>
			<p className={styles.body}>{t("saveRecovery.body")}</p>
			<div className={styles.actions}>
				<button
					type="button"
					className={`${buttons.btn} ${buttons.btnSecondary}`}
					disabled={busy || working}
					onClick={() => void recover("check")}
				>
					{t("saveRecovery.check")}
				</button>
				<button
					type="button"
					className={`${buttons.btn} ${buttons.btnPrimary}`}
					disabled={busy || working}
					onClick={() => void recover("save-copy")}
				>
					{t("saveRecovery.saveCopy")}
				</button>
				<button
					type="button"
					className={`${buttons.btn} ${buttons.dangerBtn}`}
					disabled={busy || working}
					onClick={() => void recover("reload")}
				>
					{t("saveRecovery.reload")}
				</button>
			</div>
			{message && <p className={styles.message}>{message}</p>}
		</section>
	);
}
