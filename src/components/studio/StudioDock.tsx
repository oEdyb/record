import { ArrowDownUp, Camera, Monitor, PanelsTopLeft } from "lucide-react";
import type { ReactNode } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { StudioLayout } from "@/lib/userPreferences";
import type { StudioSnapshot } from "../../../electron/studio/types";
import { StudioCamera } from "./StudioCamera";
import { StudioReplay } from "./StudioReplay";
import { StudioSeparator } from "./StudioSeparator";
import styles from "./StudioWindow.module.css";
import { splitLayout } from "./studioLayout";

export interface StudioSeekRequest {
	takeSec: number;
	nonce: number;
	play?: boolean;
}
export function StudioDock({
	snapshot,
	layout,
	update,
	seekRequest,
	hold,
	onPosition,
	playbackRequest,
	speed,
	devices,
}: {
	snapshot: StudioSnapshot;
	layout: StudioLayout;
	update: (patch: Partial<StudioLayout>) => void;
	seekRequest: StudioSeekRequest | null;
	hold: boolean;
	onPosition: (value: number) => void;
	playbackRequest: number;
	speed: number;
	/** Shown under the camera before a take. */
	devices: ReactNode;
}) {
	const t = useScopedT("launch");
	const idle = snapshot.phase === "idle";
	// With the camera off there is no live camera pane: the replay gets the whole dock.
	const cameraOn = snapshot.setup.cameraEnabled;
	const view = cameraOn ? layout.view : "replay";
	const panes = splitLayout({ ...layout, view });
	const camera = (
		<div key="camera" className={styles.cameraSlot} id="studio-live">
			<StudioCamera
				active={snapshot.shown && cameraOn && (idle || panes.camera)}
				guides={idle && layout.guides}
			/>
		</div>
	);
	const replay = (
		<div key="replay" className={styles.replaySlot} id="studio-replay">
			<StudioReplay
				clips={snapshot.clips}
				seekRequest={seekRequest}
				shown={snapshot.shown}
				hold={hold}
				onPosition={onPosition}
				playbackRequest={playbackRequest}
				speed={speed}
				cameraOnly={view === "camera"}
				labels={{
					clipOf: (current, total) => t("peek.clipOf", { current, total }),
					play: t("peek.play"),
					pause: t("peek.pause"),
					mute: t("peek.mute"),
					unmute: t("peek.unmute"),
					seek: t("peek.seek"),
					playbackError: t("peek.playbackError"),
					recorded: t("studio.recorded"),
				}}
			/>
		</div>
	);
	return (
		<aside className={styles.dock} id="studio-dock">
			<div className={styles.dockHeader} hidden={!idle && !cameraOn}>
				{idle ? (
					<>
						<span>{t("permissions.camera")}</span>
						<button
							type="button"
							aria-pressed={layout.guides}
							onClick={() => update({ guides: !layout.guides })}
						>
							{t("studio.guides")}
						</button>
					</>
				) : cameraOn ? (
					<>
						<div className={styles.viewSwitch}>
							{(["replay", "both", "camera"] as const).map((view, i) => (
								<button
									type="button"
									key={view}
									title={t(`studio.${view}`)}
									aria-label={t(`studio.${view}`)}
									aria-pressed={layout.view === view}
									onClick={() => update({ view })}
								>
									{i === 0 ? (
										<Monitor size={16} />
									) : i === 1 ? (
										<PanelsTopLeft size={16} />
									) : (
										<Camera size={16} />
									)}
								</button>
							))}
							{layout.view === "both" ? (
								<button
									type="button"
									title={t("studio.order")}
									aria-label={t("studio.order")}
									onClick={() => update({ order: layout.order === "replay" ? "camera" : "replay" })}
								>
									<ArrowDownUp size={16} />
								</button>
							) : null}
						</div>
					</>
				) : null}
			</div>
			<div
				className={styles.panes}
				style={{
					gridTemplateRows:
						idle || view === "replay"
							? "minmax(0,1fr)"
							: view === "camera"
								? "minmax(0,1fr) auto"
								: layout.order === "replay"
									? `minmax(0,${layout.split}fr) 14px minmax(0,${1 - layout.split}fr)`
									: `minmax(0,${1 - layout.split}fr) 14px minmax(0,${layout.split}fr)`,
				}}
			>
				{idle ? (
					camera
				) : view === "camera" ? (
					<>
						{camera}
						{replay}
					</>
				) : (
					<>
						{layout.order === "replay"
							? panes.replay
								? replay
								: null
							: panes.camera
								? camera
								: null}
						{view === "both" ? (
							<StudioSeparator
								controls="studio-replay studio-live"
								value={layout.split}
								reverse={layout.order === "camera"}
								onChange={(split) => update({ split: Math.min(0.85, Math.max(0.45, split)) })}
								onCollapse={(end) => {
									update({ view: end ? "replay" : "camera" });
									document.getElementById("studio-side")?.focus();
								}}
							/>
						) : null}
						{layout.order === "replay"
							? panes.camera
								? camera
								: null
							: panes.replay
								? replay
								: null}
					</>
				)}
			</div>
			{idle ? <div className={styles.dockDevices}>{devices}</div> : null}
		</aside>
	);
}
