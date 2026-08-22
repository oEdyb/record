interface KlipptMarkProps {
	className?: string;
}

/** Transparent K monogram for in-app surfaces. It scales cleanly without a raster asset. */
export function KlipptMark({ className }: KlipptMarkProps) {
	return (
		<svg className={className} viewBox="0 0 32 32" fill="none" aria-hidden="true" focusable="false">
			<path
				d="M10.5 8.5V23.5"
				stroke="var(--fg-emphasis)"
				strokeWidth="3.2"
				strokeLinecap="round"
			/>
			<path d="M13.7 16L22 8.8" stroke="var(--accent)" strokeWidth="3.2" strokeLinecap="round" />
			<path d="M13.7 16L22 23.2" stroke="var(--accent)" strokeWidth="3.2" strokeLinecap="round" />
		</svg>
	);
}
