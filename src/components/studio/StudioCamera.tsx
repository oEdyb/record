import { useRef } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./StudioWindow.module.css";
import { useStudioLiveCamera } from "./useStudioLiveCamera";

export function StudioCamera({
	active,
	guides,
	dim = false,
}: {
	active: boolean;
	guides: boolean;
	dim?: boolean;
}) {
	const ref = useRef<HTMLCanvasElement>(null);
	const ready = useStudioLiveCamera(ref, active);
	const t = useScopedT("launch");
	return (
		<div className={styles.camera} data-dim={dim}>
			<canvas ref={ref} aria-label={t("studio.live")} hidden={!active || !ready} />
			<span className={styles.liveChip}>{t("studio.live")}</span>
			{guides && active ? (
				<div className={styles.guides} aria-hidden="true">
					<i />
				</div>
			) : null}
		</div>
	);
}
