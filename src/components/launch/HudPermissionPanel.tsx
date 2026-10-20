import { Check, Mic, Monitor, Video, X } from "lucide-react";
import type { Ref } from "react";
import {
	type CapturePermissionKind,
	type CapturePermissions,
	neededPermissions,
	type PermissionNeeds,
	type PermissionStep,
} from "@/lib/capturePermissions";
import permissionStyles from "./HudPermissionPanel.module.css";
import styles from "./LaunchWindow.module.css";

export type HudPermissionLabels = {
	title: string;
	description: string;
	names: Record<CapturePermissionKind, string>;
	details: Record<CapturePermissionKind, string>;
	granted: string;
	notAsked: string;
	blocked: string;
	continue: string;
	openSettings: string;
	notNow: string;
	relaunch: string;
	relaunchHint: string;
	settingsHint: string;
};

const ICONS = { screen: Monitor, microphone: Mic, camera: Video } as const;

export function HudPermissionPanel({
	permissions,
	needs,
	step,
	labels,
	busy,
	closing,
	panelRef,
	onContinue,
	onOpenSettings,
	onRelaunch,
	onClose,
}: {
	permissions: CapturePermissions;
	needs: PermissionNeeds;
	step: PermissionStep;
	labels: HudPermissionLabels;
	busy: boolean;
	closing: boolean;
	panelRef?: Ref<HTMLDivElement>;
	onContinue: () => void;
	onOpenSettings: (kind: CapturePermissionKind) => void;
	onRelaunch: () => void;
	onClose: () => void;
}) {
	const hint =
		step.kind === "settings" ? (step.relaunch ? labels.relaunchHint : labels.settingsHint) : null;
	return (
		<div
			ref={panelRef}
			data-hud-interactive="true"
			data-testid="hud-permission-panel"
			data-closing={closing}
			role="dialog"
			aria-labelledby="hud-permission-title"
			aria-describedby="hud-permission-description"
			className={`${styles.hudModal} ${styles.hudPanel} ${styles.electronNoDrag}`}
		>
			<div className={styles.hudModalHeader}>
				<span id="hud-permission-title" className={permissionStyles.title}>
					{labels.title}
				</span>
				<button
					type="button"
					aria-label={labels.notNow}
					title={labels.notNow}
					onClick={onClose}
					className={styles.hudModalClose}
				>
					<X size={14} aria-hidden />
				</button>
			</div>
			<p id="hud-permission-description" className={permissionStyles.description}>
				{labels.description}
			</p>
			<ul className={permissionStyles.rows}>
				{neededPermissions(needs).map((kind) => {
					const status = permissions[kind];
					const Icon = ICONS[kind];
					const granted = status === "granted";
					const blocked = status === "denied" || status === "restricted";
					return (
						<li key={kind} className={permissionStyles.row} data-status={status}>
							<span className={permissionStyles.icon} aria-hidden>
								<Icon size={16} />
							</span>
							<span className={permissionStyles.text}>
								<span className={permissionStyles.name}>{labels.names[kind]}</span>
								<span className={permissionStyles.detail}>{labels.details[kind]}</span>
							</span>
							{blocked ? (
								<>
									<span className={permissionStyles.status} role="status">
										{labels.blocked}
									</span>
									<button
										type="button"
										className={permissionStyles.settingsButton}
										aria-label={`${labels.openSettings}: ${labels.names[kind]}`}
										onClick={() => onOpenSettings(kind)}
									>
										{labels.openSettings}
									</button>
								</>
							) : (
								<span className={permissionStyles.status} role="status">
									{granted ? <Check size={13} aria-hidden /> : null}
									{granted ? labels.granted : labels.notAsked}
								</span>
							)}
						</li>
					);
				})}
			</ul>
			{hint ? <p className={permissionStyles.hint}>{hint}</p> : null}
			<div className={styles.hudSetupFooter}>
				<button type="button" className={styles.hudSetupFooterButton} onClick={onClose}>
					{labels.notNow}
				</button>
				{step.kind === "ask" ? (
					<button
						type="button"
						className={`${styles.hudSetupFooterButton} ${permissionStyles.primary}`}
						disabled={busy}
						onClick={onContinue}
					>
						{labels.continue}
					</button>
				) : step.kind === "settings" && step.relaunch ? (
					<button
						type="button"
						className={`${styles.hudSetupFooterButton} ${permissionStyles.primary}`}
						onClick={onRelaunch}
					>
						{labels.relaunch}
					</button>
				) : null}
			</div>
		</div>
	);
}
