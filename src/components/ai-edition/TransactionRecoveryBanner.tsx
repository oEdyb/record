import { useState } from "react";
import {
	reconcileProjectTransactions,
	resolveLocalTransactionConflict,
	useProjectStore,
} from "@/lib/ai-edition/store/projectStore";

/** Recovery is explicit: a conflict must never silently discard the live edit. */
export function TransactionRecoveryBanner() {
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
			setMessage(
				error instanceof Error ? error.message : "Recovery failed. Your edit remains open.",
			);
		} finally {
			setWorking(false);
		}
	};
	return (
		<section
			role="alert"
			aria-label="Save recovery"
			style={{
				position: "absolute",
				top: 64,
				left: "50%",
				transform: "translateX(-50%)",
				zIndex: 100,
				width: "min(620px, 90%)",
				padding: 16,
				borderRadius: 12,
				background: "var(--background, #202024)",
				color: "var(--foreground, #fff)",
				border: "1px solid #a88a44",
				boxShadow: "0 8px 30px #0006",
			}}
		>
			<p>Saving needs recovery. Your current edit remains open.</p>
			<p>
				Check an interrupted agent edit first. Save a copy to keep your version. Reload discards
				unsaved changes and opens the saved version.
			</p>
			<div style={{ display: "flex", gap: 12, marginTop: 12 }}>
				<button type="button" disabled={busy || working} onClick={() => void recover("check")}>
					Check interrupted edit
				</button>
				<button type="button" disabled={busy || working} onClick={() => void recover("save-copy")}>
					Save my version as a copy
				</button>
				<button type="button" disabled={busy || working} onClick={() => void recover("reload")}>
					Discard unsaved changes and reload
				</button>
			</div>
			{message && <p style={{ marginTop: 12 }}>{message}</p>}
		</section>
	);
}
