import {
	AppWindow,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	Delete,
	SlidersHorizontal,
} from "lucide-react";
import { memo, type ReactNode, useRef } from "react";
import { formatTimePadded } from "../../utils/timeUtils";
import { KlipptMark } from "../brand/KlipptMark";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { CameraIcon, getIcon, MicIcon, SourceIcon, VolumeIcon } from "./HudIcons";
import styles from "./LaunchWindow.module.css";

// Every control below is a `memo` boundary on purpose. The HUD's root re-renders
// once a second for the whole duration of a recording (the elapsed-time counter),
// and without these boundaries each tick rebuilt every Radix tooltip tree. Props
// are kept primitive (or stable refs/callbacks from the parent) so the boundaries
// actually hold.

const hudDisabledClasses =
	"disabled:opacity-30 disabled:cursor-not-allowed disabled:pointer-events-none";
const hudFocusClasses =
	"focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#8ea5bf] focus-visible:ring-offset-2 focus-visible:ring-offset-[#101318]";

// Pill geometry: 4px inset, a 40px primary circle, 36px secondary circles
// centred on the same 40px track. Every radius is concentric with the pill.
const hudIconBtnBase = `flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-0 bg-transparent cursor-pointer transition-[background-color,color,transform,opacity] duration-150 hover:bg-white/[0.07] hover:text-[#f5f7fa] active:scale-[0.94] ${hudFocusClasses} ${hudDisabledClasses} ${styles.hudIconDim} ${styles.electronNoDrag}`;
const hudIconBtnClasses = `${hudIconBtnBase} text-[#7d8794]`;
const hudIconBtnActiveClasses = `${hudIconBtnBase} bg-white/[0.09] text-[#f5f7fa]`;

/** Pointer travel below which a press on the grip counts as a click, not a drag. */
const HUD_GRIP_TAP_SLOP = 4;

export const HudDragHandle = memo(function HudDragHandle({
	nativeDrag,
	onPointerDown,
	onPointerMove,
	onPointerEnd,
	onTap,
	tapExpanded,
	roomy = false,
	children,
	label,
}: {
	children: ReactNode;
	label?: string;
	/** A larger grab target, for the folded pill where the grip is most of the surface. */
	roomy?: boolean;
	/**
	 * Hand the gesture to the compositor instead of the pointer handlers below.
	 *
	 * Wayland forbids a client from reading or setting its own global position:
	 * `getPosition()` answers [0, 0] and `setPosition()` only updates Electron's
	 * own cache, so the origin+delta scheme the handlers implement cannot move
	 * the window there. `-webkit-app-region: drag` is the one path that does —
	 * it routes to `xdg_toplevel.move` and the compositor performs the move.
	 */
	nativeDrag: boolean;
	onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
	onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
	onPointerEnd: (event: React.PointerEvent<HTMLDivElement>) => void;
	/** A press released without dragging, or Enter/Space on the focused grip. */
	onTap?: (fromKeyboard: boolean) => void;
	/** With `onTap`, whether the grip's tap currently shows the full pill. */
	tapExpanded?: boolean;
}) {
	// Where the press started, and whether it ever travelled far enough to be a drag.
	const pressRef = useRef<{ x: number; y: number; dragged: boolean } | null>(null);
	const tappable = Boolean(onTap);
	return (
		<div
			data-testid="hud-drag-handle"
			data-hud-grip={tappable ? "" : undefined}
			title={label}
			role={tappable ? "button" : undefined}
			tabIndex={tappable ? 0 : undefined}
			aria-label={tappable ? label : undefined}
			aria-expanded={tappable ? tapExpanded : undefined}
			className={`flex ${roomy ? "h-10 min-w-12" : "h-9 min-w-9"} shrink-0 cursor-grab items-center justify-center rounded-full active:cursor-grabbing ${hudFocusClasses} ${
				nativeDrag ? styles.electronDrag : styles.electronNoDrag
			}`}
			onPointerDown={(event) => {
				pressRef.current = { x: event.screenX, y: event.screenY, dragged: false };
				onPointerDown(event);
			}}
			onPointerMove={(event) => {
				const press = pressRef.current;
				if (
					press &&
					Math.hypot(event.screenX - press.x, event.screenY - press.y) >= HUD_GRIP_TAP_SLOP
				) {
					press.dragged = true;
				}
				onPointerMove(event);
			}}
			onPointerUp={(event) => {
				const press = pressRef.current;
				pressRef.current = null;
				onPointerEnd(event);
				if (
					onTap &&
					press &&
					!press.dragged &&
					Math.hypot(event.screenX - press.x, event.screenY - press.y) < HUD_GRIP_TAP_SLOP
				) {
					onTap(false);
				}
			}}
			onPointerCancel={(event) => {
				pressRef.current = null;
				onPointerEnd(event);
			}}
			onLostPointerCapture={onPointerEnd}
			onKeyDown={(event) => {
				if (!onTap || (event.key !== "Enter" && event.key !== " ")) return;
				event.preventDefault();
				if (!event.repeat) onTap(true);
			}}
		>
			{children}
		</div>
	);
});

export function HudBrandMark() {
	return <KlipptMark className={styles.hudBrandMark} />;
}

/**
 * The tab a pill tucked into an edge leaves. With no take it is the mark, pointing back
 * out; with one it says the take is open and how long it runs, so nothing is hidden
 * while recording.
 */
export function HudDockMark({
	side,
	take,
	elapsedSeconds,
}: {
	side: "left" | "right" | "top";
	take: "recording" | "paused" | null;
	elapsedSeconds: number;
}) {
	if (take) {
		return (
			<span className={styles.hudDockMark} data-side={side} data-take={take}>
				<span data-testid="hud-dock-take" className={styles.hudDockTake} />
				<span role="timer" className={styles.hudDockTimer}>
					{formatTimePadded(elapsedSeconds)}
				</span>
			</span>
		);
	}
	const Chevron = side === "left" ? ChevronRight : side === "right" ? ChevronLeft : ChevronDown;
	return (
		<span className={styles.hudDockMark} data-side={side}>
			<KlipptMark className={styles.hudBrandMark} />
			<Chevron size={12} strokeWidth={2.5} aria-hidden="true" className={styles.hudDockChevron} />
		</span>
	);
}

export const HudSourceChip = memo(function HudSourceChip({
	label,
	kind = "display",
	expanded = false,
	disabled,
	onClick,
	onIntent,
}: {
	label: string;
	kind?: "display" | "window";
	expanded?: boolean;
	disabled: boolean;
	onClick: () => void;
	/** The pointer reached the chip: a click is likely, so start loading sources. */
	onIntent?: () => void;
}) {
	return (
		<button
			type="button"
			onPointerEnter={onIntent}
			data-testid="launch-source-selector-button"
			data-hud-popover-trigger="true"
			aria-expanded={expanded}
			aria-haspopup="dialog"
			className={`${styles.hudSourceChip} ${hudFocusClasses} ${hudDisabledClasses} ${styles.electronNoDrag}`}
			onClick={onClick}
			disabled={disabled}
			title={label}
			aria-label={label}
		>
			{kind === "window" ? (
				<AppWindow size={16} strokeWidth={1.75} className={styles.hudSourceChipIcon} aria-hidden />
			) : (
				<SourceIcon className={styles.hudSourceChipIcon} />
			)}
			<span className="min-w-0 flex-1 truncate text-left">{label}</span>
			<ChevronDown size={14} className={styles.hudSourceChipChevron} aria-hidden />
		</button>
	);
});

export const HudSystemAudioButton = memo(function HudSystemAudioButton({
	enabled,
	disabled,
	label,
	onClick,
}: {
	enabled: boolean;
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid="launch-system-audio-button"
			className={enabled ? `${hudIconBtnBase} text-[#f5f7fa]` : hudIconBtnClasses}
			aria-pressed={enabled}
			onClick={onClick}
			disabled={disabled}
			title={label}
		>
			<VolumeIcon muted={!enabled} />
		</button>
	);
});

export const HudMicButton = memo(function HudMicButton({
	enabled,
	disabled,
	label,
	level,
	onClick,
}: {
	enabled: boolean;
	disabled: boolean;
	label: string;
	/** Live input level, 0 to 100. Omitted when the mic is not being listened to. */
	level?: number;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid="launch-microphone-button"
			className={`relative ${enabled ? `${hudIconBtnBase} text-[#f5f7fa]` : hudIconBtnClasses}`}
			aria-pressed={enabled}
			onClick={onClick}
			disabled={disabled}
			title={label}
		>
			<MicIcon muted={!enabled} />
			{level !== undefined ? (
				<span
					className={styles.hudLevel}
					style={{ transform: `scaleX(${Math.min(1, Math.max(0, level / 100))})` }}
					aria-hidden
				/>
			) : null}
		</button>
	);
});

export const HudCameraButton = memo(function HudCameraButton({
	enabled,
	disabled,
	label,
	onClick,
}: {
	enabled: boolean;
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			data-testid="launch-webcam-button"
			className={enabled ? `${hudIconBtnBase} text-[#f5f7fa]` : hudIconBtnClasses}
			aria-pressed={enabled}
			onClick={onClick}
			disabled={disabled}
			title={label}
		>
			<CameraIcon off={!enabled} />
		</button>
	);
});

export const HudSettingsButton = memo(function HudSettingsButton({
	disabled,
	expanded,
	label,
	onClick,
	onIntent,
}: {
	disabled: boolean;
	expanded: boolean;
	label: string;
	onClick: () => void;
	onIntent?: () => void;
}) {
	return (
		<Tooltip content={label}>
			<button
				type="button"
				data-testid="launch-device-settings-button"
				data-hud-popover-trigger="true"
				aria-label={label}
				aria-expanded={expanded}
				aria-haspopup="dialog"
				className={expanded ? hudIconBtnActiveClasses : hudIconBtnClasses}
				onClick={onClick}
				onPointerEnter={onIntent}
				disabled={disabled}
			>
				<SlidersHorizontal size={18} aria-hidden />
			</button>
		</Tooltip>
	);
});

export const HudRemovePreviousClipButton = memo(function HudRemovePreviousClipButton({
	disabled,
	label,
	tooltip,
	onClick,
}: {
	disabled: boolean;
	label: string;
	tooltip?: string;
	onClick: () => void;
}) {
	return (
		<Tooltip content={tooltip ?? label}>
			<button
				type="button"
				data-testid="hud-remove-previous-clip-button"
				className={hudIconBtnClasses}
				onClick={onClick}
				disabled={disabled}
				aria-label={label}
			>
				<Delete size={18} aria-hidden />
			</button>
		</Tooltip>
	);
});

export const HudCompactPauseButton = memo(function HudCompactPauseButton({
	testId = "hud-compact-pause-button",
	paused,
	busy = false,
	disabled,
	label,
	onClick,
}: {
	testId?: string;
	paused: boolean;
	/** The writer is still closing the clip: the state has flipped, the file has not. */
	busy?: boolean;
	disabled: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<Tooltip content={label}>
			<button
				type="button"
				data-testid={testId}
				data-paused={paused}
				data-busy={busy}
				aria-busy={busy}
				className={`${styles.hudPrimaryTransport} ${hudFocusClasses} ${styles.electronNoDrag}`}
				onClick={onClick}
				disabled={disabled}
				aria-label={label}
			>
				<TransportGlyph paused={paused} />
			</button>
		</Tooltip>
	);
});

export const HudCompactRecordButton = memo(function HudCompactRecordButton({
	disabled,
	label,
	accessibleLabel,
	onClick,
	onIntent,
}: {
	disabled: boolean;
	label: string;
	accessibleLabel?: string;
	onClick: () => void;
	/** The pointer or focus reached Record, so a click is likely next. */
	onIntent?: () => void;
}) {
	return (
		<Tooltip content={label}>
			<button
				type="button"
				data-testid="launch-record-button"
				className={`${styles.hudRecordButton} ${hudFocusClasses} ${styles.electronNoDrag}`}
				onClick={onClick}
				onPointerEnter={onIntent}
				onFocus={onIntent}
				disabled={disabled}
				title={label}
				aria-label={accessibleLabel ?? label}
			>
				<span className={styles.hudRecordBall} aria-hidden />
			</button>
		</Tooltip>
	);
});

function TransportGlyph({ paused }: { paused: boolean }) {
	return (
		<svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true">
			{paused ? (
				<path
					d="M5 3.2v9.6a.6.6 0 0 0 .92.5l7.3-4.8a.6.6 0 0 0 0-1L5.92 2.7A.6.6 0 0 0 5 3.2Z"
					fill="currentColor"
				/>
			) : (
				<>
					<rect x="3.5" y="2.5" width="3.2" height="11" rx="1" fill="currentColor" />
					<rect x="9.3" y="2.5" width="3.2" height="11" rx="1" fill="currentColor" />
				</>
			)}
		</svg>
	);
}

export const HudCompactTimer = memo(function HudCompactTimer({
	elapsedSeconds,
	paused,
}: {
	elapsedSeconds: number;
	paused: boolean;
}) {
	return (
		<span className={styles.hudCompactTimer} data-testid="hud-recording-timer" data-paused={paused}>
			<span role="timer">{formatTimePadded(elapsedSeconds)}</span>
		</span>
	);
});

export const HudStopButton = memo(function HudStopButton({
	saving,
	disabled,
	label,
	savingLabel,
	onClick,
}: {
	saving: boolean;
	disabled: boolean;
	label: string;
	savingLabel: string;
	onClick: () => void;
}) {
	const name = saving ? savingLabel : label;
	return (
		<Tooltip content={name}>
			<button
				type="button"
				data-testid="launch-record-button"
				className={hudIconBtnClasses}
				onClick={onClick}
				disabled={disabled}
				title={name}
				aria-label={name}
				aria-busy={saving}
			>
				{saving ? (
					<span className="animate-spin flex items-center justify-center">
						{getIcon("spinner", "text-white/70")}
					</span>
				) : (
					<span className={styles.hudStopGlyph} aria-hidden />
				)}
			</button>
		</Tooltip>
	);
});

export const HudExpandButton = memo(function HudExpandButton({
	expanded,
	label,
	disabled = false,
	onClick,
}: {
	expanded: boolean;
	label: string;
	disabled?: boolean;
	onClick: () => void;
}) {
	return (
		<Tooltip content={label}>
			<button
				type="button"
				data-testid="hud-expand-button"
				data-hud-popover-trigger="true"
				className={expanded ? hudIconBtnActiveClasses : hudIconBtnClasses}
				disabled={disabled}
				onClick={onClick}
				aria-label={label}
				aria-expanded={expanded}
			>
				<ChevronUp
					size={18}
					aria-hidden
					className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
				/>
			</button>
		</Tooltip>
	);
});

export const HudNotice = memo(function HudNotice({
	title,
	description,
	dismissLabel,
	confirmLabel,
	onDismiss,
	onConfirm,
}: {
	title: string;
	description: string;
	dismissLabel: string;
	confirmLabel: string;
	onDismiss: () => void;
	onConfirm: () => void;
}) {
	return (
		<div
			data-hud-interactive="true"
			className={`w-full rounded-xl border border-white/15 bg-[rgba(20,20,28,0.95)] p-3 shadow-2xl backdrop-blur-xl text-white animate-in fade-in-0 zoom-in-95 duration-200 ${styles.electronNoDrag}`}
		>
			<div className="text-[13px] font-semibold text-white">{title}</div>
			<div className="mt-1 text-[11px] leading-relaxed text-white/75">{description}</div>
			<div className="mt-3 flex items-center justify-end gap-2">
				<Button
					type="button"
					variant="ghost"
					size="sm"
					onClick={onDismiss}
					className="h-7 text-xs text-white/80 hover:bg-white/10 hover:text-white"
				>
					{dismissLabel}
				</Button>
				<Button
					type="button"
					size="sm"
					onClick={onConfirm}
					className="h-7 text-xs bg-white text-[#10121b] hover:bg-white/90"
				>
					{confirmLabel}
				</Button>
			</div>
		</div>
	);
});
