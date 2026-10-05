import { AppWindow, Monitor, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { Button } from "../ui/button";
import styles from "./SourceSelector.module.css";

interface DesktopSource {
	id: string;
	name: string;
	thumbnail: string | null;
	display_id: string;
	appIcon: string | null;
}

const PICKER_SOURCE_OPTIONS: Electron.SourcesOptions = {
	types: ["screen", "window"],
	thumbnailSize: { width: 320, height: 180 },
	fetchWindowIcons: true,
};

function toDesktopSources(rawSources: ProcessedDesktopSource[]): DesktopSource[] {
	return rawSources.map((source) => ({
		id: source.id,
		name:
			source.id.startsWith("window:") && source.name.includes(" — ")
				? source.name.split(" — ")[1] || source.name
				: source.name,
		thumbnail: source.thumbnail || null,
		display_id: source.display_id,
		appIcon: source.appIcon,
	}));
}

let pickerPrefetch: Promise<unknown> | null = null;

/**
 * Starts reading screens and windows before the picker opens, such as when the
 * pointer reaches the source chip. Main keeps the result for the picker.
 */
export function prefetchPickerSources() {
	if (pickerPrefetch || !window.electronAPI?.getSources) return;
	pickerPrefetch = window.electronAPI
		.getSources(PICKER_SOURCE_OPTIONS)
		.catch(() => undefined)
		.finally(() => {
			pickerPrefetch = null;
		});
}

/** The standalone picker window, used when the recorder has to ask for screen access first. */
export function SourceSelector() {
	return <SourcePicker variant="window" onClose={() => window.close()} />;
}

/**
 * Screens and windows to record, one click to choose. Renders as its own window
 * or as a panel above the recorder pill.
 */
export type SourcePickerKind = "screens" | "windows";

export function SourcePicker({
	variant,
	initialKind,
	onClose,
	onChosen,
	panelRef,
	className = "",
	closing = false,
}: {
	variant: "window" | "panel";
	/** The tab to open on, when the caller asked for screens or windows. */
	initialKind?: SourcePickerKind;
	/** Extra classes for the panel shell, such as the HUD's motion. */
	className?: string;
	/** True while the panel plays its exit before unmounting. */
	closing?: boolean;
	onClose: () => void;
	onChosen?: () => void;
	panelRef?: (el: HTMLDivElement | null) => void;
}) {
	const t = useScopedT("launch");
	const tc = useScopedT("common");
	const [sources, setSources] = useState<DesktopSource[]>([]);
	const [selectedSource, setSelectedSource] = useState<DesktopSource | null>(null);
	const [loading, setLoading] = useState(true);
	const [loadFailed, setLoadFailed] = useState(false);

	const fetchSources = useCallback(async () => {
		setLoadFailed(false);
		const showSources = async (mapped: DesktopSource[]) => {
			setSources(mapped);
			const chosen = await window.electronAPI.getSelectedSource?.().catch(() => null);
			setSelectedSource((current) => {
				const id = current?.id ?? chosen?.id;
				return mapped.find((source) => source.id === id) ?? null;
			});
		};
		// Last time's list shows at once; fresh thumbnails replace it when they arrive.
		const cached = await window.electronAPI.getCachedSources?.().catch(() => null);
		const hasCached = Boolean(cached && cached.length > 0);
		if (cached && hasCached) {
			await showSources(toDesktopSources(cached));
			setLoading(false);
		} else {
			setLoading(true);
		}
		try {
			await showSources(
				toDesktopSources(await window.electronAPI.getSources(PICKER_SOURCE_OPTIONS)),
			);
		} catch (error) {
			console.error("Error loading sources:", error);
			if (!hasCached) {
				setSources([]);
				setSelectedSource(null);
				setLoadFailed(true);
			}
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void fetchSources();
	}, [fetchSources]);

	const screenSources = sources.filter((s) => s.id.startsWith("screen:"));
	const windowSources = sources.filter((s) => s.id.startsWith("window:"));
	const hasNoSources = !loading && sources.length === 0;

	// One click chooses; the main process closes the picker once the choice is saved.
	const [choosing, setChoosing] = useState(false);
	const handleSourceSelect = async (source: DesktopSource) => {
		if (choosing) return;
		const previous = selectedSource;
		setChoosing(true);
		setSelectedSource(source);
		try {
			await window.electronAPI.selectSource(source);
			onChosen?.();
		} catch (error) {
			console.error("Error selecting source:", error);
			setSelectedSource(previous);
			toast.error(t("sourceSelector.selectFailed"));
		} finally {
			setChoosing(false);
		}
	};
	const [kind, setKind] = useState<SourcePickerKind | null>(initialKind ?? null);
	const activeKind =
		kind ??
		(screenSources.length === 0 || selectedSource?.id.startsWith("window:")
			? "windows"
			: "screens");
	const visibleSources = activeKind === "screens" ? screenSources : windowSources;

	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const panelTestId = variant === "panel" ? "hud-source-panel" : undefined;
	const shellClass =
		variant === "window"
			? `h-screen flex flex-col ${styles.glassContainer}`
			: `flex flex-col ${styles.glassContainer} ${styles.panel} ${className}`;

	if (hasNoSources) {
		return (
			<div
				ref={panelRef}
				data-hud-interactive="true"
				data-testid={panelTestId}
				data-closing={closing}
				className={`${shellClass} items-center justify-center ${styles.stateShell}`}
			>
				<div className="max-w-[320px] px-6 text-center">
					<h2 className="text-sm font-semibold text-[#ffffff]">{t("sourceSelector.emptyTitle")}</h2>
					<p className="mt-2 text-xs leading-5 text-[#828c99]">
						{loadFailed
							? t("sourceSelector.loadFailedDescription")
							: t("sourceSelector.emptyDescription")}
					</p>
					<Button
						onClick={() => void fetchSources()}
						className="mt-4 h-8 rounded-[9px] bg-[var(--accent)] px-5 text-[11px] font-semibold text-[var(--accent-on)] transition-[background-color,transform] duration-150 hover:bg-[var(--brand-lo)] active:scale-95"
					>
						{tc("actions.reload")}
					</Button>
				</div>
			</div>
		);
	}

	const renderSourceCard = (source: DesktopSource) => {
		const isSelected = selectedSource?.id === source.id;
		const sourceKind = source.id.startsWith("screen:") ? "screen" : "window";
		return (
			<button
				key={source.id}
				type="button"
				data-testid="source-selector-card"
				data-source-kind={sourceKind}
				aria-pressed={isSelected}
				disabled={choosing}
				className={styles.sourceCard}
				onClick={() => void handleSourceSelect(source)}
			>
				<div className={styles.thumb}>
					{source.thumbnail ? (
						<img src={source.thumbnail} alt={source.name} />
					) : (
						<div
							className={styles.thumbFallback}
							data-testid="source-thumbnail-placeholder"
							aria-hidden="true"
						>
							{sourceKind === "screen" ? (
								<Monitor size={28} strokeWidth={1.5} />
							) : (
								<AppWindow size={28} strokeWidth={1.5} />
							)}
						</div>
					)}
				</div>
				<div className={styles.caption}>
					{source.appIcon ? (
						<img src={source.appIcon} alt="" className={styles.icon} />
					) : sourceKind === "screen" ? (
						<Monitor size={14} className={styles.captionIcon} aria-hidden />
					) : (
						<AppWindow size={14} className={styles.captionIcon} aria-hidden />
					)}
					<span className={styles.name}>{source.name}</span>
				</div>
			</button>
		);
	};

	return (
		<div
			ref={panelRef}
			data-hud-interactive="true"
			data-testid={panelTestId}
			data-closing={closing}
			className={shellClass}
			data-rows={Math.min(
				3,
				Math.ceil(Math.max(1, screenSources.length, windowSources.length) / 2),
			)}
		>
			<div className={styles.header}>
				<div
					className={styles.segmented}
					role="tablist"
					aria-label={t("sourceSelector.screens", { count: String(screenSources.length) })}
					data-kind={activeKind}
				>
					<span className={styles.segmentThumb} aria-hidden />
					<button
						type="button"
						role="tab"
						aria-selected={activeKind === "screens"}
						className={styles.segment}
						onClick={() => setKind("screens")}
					>
						<Monitor size={15} aria-hidden />
						{t("sourceSelector.screens", { count: String(screenSources.length) })}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeKind === "windows"}
						className={styles.segment}
						onClick={() => setKind("windows")}
					>
						<AppWindow size={15} aria-hidden />
						{t("sourceSelector.windows", { count: String(windowSources.length) })}
					</button>
				</div>
				<button
					type="button"
					data-testid="source-selector-cancel-button"
					className={styles.close}
					aria-label={tc("actions.cancel")}
					title={tc("actions.cancel")}
					onClick={onClose}
				>
					<X size={16} aria-hidden />
				</button>
			</div>
			<div
				className={`${styles.grid} ${styles.sourceGridScroll}`}
				role="tabpanel"
				aria-busy={loading}
			>
				{loading ? (
					<>
						<span className="sr-only">{t("sourceSelector.loading")}</span>
						{[0, 1, 2, 3].map((slot) => (
							<div key={slot} className={styles.sourceCard} data-placeholder aria-hidden>
								<div className={styles.thumb} />
								<div className={styles.caption} />
							</div>
						))}
					</>
				) : (
					visibleSources.map(renderSourceCard)
				)}
			</div>
		</div>
	);
}
