import { useScopedT } from "@/contexts/I18nContext";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import type { CleanCutStrength } from "@/lib/cleanCut/types";
import styles from "./CleanCutHud.module.css";

const STRENGTHS: CleanCutStrength[] = ["gentle", "clean"];

/** Gentle or Clean, as a two-way switch; quiet on the card, regular in the sheet. */
export function StrengthSwitch({ quiet = false }: { quiet?: boolean }) {
	const t = useScopedT("editor");
	const strength = useCleanCutStore((s) => s.strength);
	return (
		<div
			className={styles.strength}
			data-quiet={quiet || undefined}
			data-value={strength}
			role="radiogroup"
			aria-label={t("cleanCut.strength")}
		>
			<span className={styles.strengthThumb} aria-hidden="true" />
			{STRENGTHS.map((value) => (
				<button
					key={value}
					type="button"
					role="radio"
					aria-checked={strength === value}
					onClick={() => useCleanCutStore.getState().setStrength(value)}
				>
					{t(value === "gentle" ? "cleanCut.gentle" : "cleanCut.clean")}
				</button>
			))}
		</div>
	);
}
