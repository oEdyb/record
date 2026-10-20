import { useEffect, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./CountdownOverlay.module.css";

export function CountdownOverlay() {
	const t = useScopedT("launch");
	const [value, setValue] = useState<number | null>(null);

	useEffect(() => {
		const unsubscribe = window.electronAPI.onCountdownOverlayValue((nextValue) => {
			setValue(nextValue);
		});

		return () => unsubscribe();
	}, []);

	if (value === null) {
		return null;
	}

	return (
		<div className={styles.stage}>
			<div className={styles.dial}>
				{/* A new key per digit replays its entrance. */}
				<div key={value} className={styles.digit} role="status" aria-live="assertive">
					{value}
				</div>
			</div>
			<p className={styles.hint}>{t("countdown.cancelHint")}</p>
		</div>
	);
}
