import { useScopedT } from "@/contexts/I18nContext";
import styles from "./StudioWindow.module.css";
import type { StudioSection } from "./studioTranscriptModel";

export function StudioRail({
	sections,
	total,
	position,
	seek,
}: {
	sections: StudioSection[];
	total: number;
	position: number;
	seek: (time: number) => void;
}) {
	const t = useScopedT("launch");
	return (
		<nav className={styles.rail} aria-label={t("transcript.title")}>
			{sections.map((section, i) => {
				const end = sections[i + 1]?.startSec ?? total;
				const active = position >= section.startSec && position < end;
				return (
					<button
						type="button"
						key={section.clipIndex}
						aria-label={t("transcript.clip", { n: section.clipIndex + 1 })}
						aria-current={active ? "true" : undefined}
						onClick={() => seek(section.startSec)}
						style={{ flexGrow: Math.max(0.1, end - section.startSec) }}
					>
						<span hidden={sections.length > 8 && i % 2 === 1 && !active}>
							{String(section.clipIndex + 1).padStart(2, "0")}
						</span>
						<i />
					</button>
				);
			})}
		</nav>
	);
}
