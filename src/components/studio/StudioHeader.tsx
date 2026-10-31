import { Minimize2, PanelsLeftRight } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./StudioWindow.module.css";

export function StudioHeader({
	mac,
	phaseLabel,
	help,
	resize,
	side,
	pill,
}: {
	mac: boolean;
	phaseLabel: string;
	help: () => void;
	resize: (delta: number) => void;
	side: () => void;
	pill: () => void;
}) {
	const t = useScopedT("launch");
	return (
		<header className={styles.header} style={{ paddingLeft: mac ? 88 : 16 }}>
			<span className={styles.title}>{t("studio.title")}</span>
			<span className={styles.phase}>{phaseLabel}</span>
			<button type="button" aria-label={t("studio.shortcuts")} onClick={help}>
				?
			</button>
			<button type="button" aria-label={t("studio.smaller")} onClick={() => resize(-1)}>
				A−
			</button>
			<button type="button" aria-label={t("studio.larger")} onClick={() => resize(1)}>
				A+
			</button>
			<button type="button" id="studio-side" aria-label={t("studio.side")} onClick={side}>
				<PanelsLeftRight size={16} />
			</button>
			<button type="button" aria-label={t("studio.backToPill")} onClick={pill}>
				<Minimize2 size={16} />
			</button>
		</header>
	);
}
