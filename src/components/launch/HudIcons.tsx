import { Loader2 } from "lucide-react";

export const ICON_SIZE = 20;

const ICON_CONFIG = {
	spinner: { icon: Loader2, size: ICON_SIZE },
} as const;

export type IconName = keyof typeof ICON_CONFIG;

/** Renders the configured icon for a HUD control. */
export function getIcon(name: IconName, className?: string) {
	const { icon: Icon, size } = ICON_CONFIG[name];
	return <Icon size={size} className={className} />;
}

// Custom glyphs matching the Claude Design "OpenScreen Recording Widget"
// spec exactly (source/audio/mic/camera/cursor/record) — these are the
// controls most visible in the collapsed toolbar, so the design's own paths
// are used verbatim rather than the closest lucide/react-icons stand-in.
const HUD_SVG_PROPS = {
	width: ICON_SIZE,
	height: ICON_SIZE,
	viewBox: "0 0 24 24",
	fill: "none",
	stroke: "currentColor",
	strokeWidth: 1.6,
	strokeLinecap: "round",
	strokeLinejoin: "round",
} as const;

export function SourceIcon({ className }: { className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<rect x="2.5" y="4.5" width="19" height="13" rx="2.2" />
			<path d="M8.5 21h7M12 17.5v3.3" />
		</svg>
	);
}

export function VolumeIcon({ muted, className }: { muted: boolean; className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<path
				d="M10.2 5.6 5.6 9H3a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h2.6l4.6 3.4a.6.6 0 0 0 1-.48V6.08a.6.6 0 0 0-1-.48Z"
				fill="currentColor"
				stroke="none"
			/>
			{muted ? (
				<path d="M15.2 9.3 19.4 14.7M19.4 9.3l-4.2 5.4" />
			) : (
				<>
					<path d="M15.5 8.5a5 5 0 0 1 0 7" />
					<path d="M18 6a9 9 0 0 1 0 12" />
				</>
			)}
		</svg>
	);
}

export function MicIcon({ muted, className }: { muted: boolean; className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<rect x="9" y="3" width="6" height="11" rx="3" />
			<path d="M18.5 11a6.5 6.5 0 0 1-13 0" />
			<path d="M12 17.5v3" />
			{muted ? <path d="M4 4l16 16" /> : null}
		</svg>
	);
}

export function CameraIcon({ off, className }: { off: boolean; className?: string }) {
	return (
		<svg {...HUD_SVG_PROPS} className={className} aria-hidden="true">
			<rect x="3" y="6.5" width="13" height="11" rx="2.4" />
			<path d="M16 10.3 21 7v10l-5-3.3" />
			{off ? <path d="M4 4l16 16" /> : null}
		</svg>
	);
}
