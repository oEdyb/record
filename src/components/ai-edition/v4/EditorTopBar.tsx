import {
	Check,
	ChevronDown,
	Circle,
	Download,
	Film,
	FolderOpen,
	FolderPlus,
	Languages,
	LoaderCircle,
	LockKeyhole,
	Moon,
	PanelLeft,
	Save,
	Settings,
	Sparkles,
	Sun,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { KlipptMark } from "@/components/brand/KlipptMark";
import { useI18n, useScopedT } from "@/contexts/I18nContext";
import { useTheme } from "@/hooks/useTheme";
import { getAvailableLocales, getLocaleName, getLocaleShort } from "@/i18n/loader";
import { PRODUCT_SURFACE } from "@/lib/productSurface";
import styles from "./EditorShellV4.module.css";

export type EditorMode = "media" | "edit";

export interface TopBarActions {
	openProject: () => void;
	newProject: () => void;
	importMedia: () => void;
	save: () => void;
	export: () => void;
	openSettings: () => void;
	renameProject: (title: string) => void;
	toggleChat: () => void;
	record: () => void;
	regenerateAutomaticEdits: () => void;
}

interface EditorTopBarProps {
	mode: EditorMode;
	onModeChange: (mode: EditorMode) => void;
	projectTitle: string | null;
	dirty: boolean;
	canExport: boolean;
	canImportMedia: boolean;
	canRegenerateAutomaticEdits: boolean;
	regeneratingAutomaticEdits: boolean;
	importingMedia: boolean;
	chatOpen: boolean;
	readOnly: boolean;
	entitlementLabel: string | null;
	onEntitlement: () => void;
	actions: TopBarActions;
}

const ALL_MODES: Array<{ id: EditorMode; labelKey: string }> = [
	{ id: "media", labelKey: "topbar.modes.media" },
	{ id: "edit", labelKey: "topbar.modes.edit" },
];

const MODES = PRODUCT_SURFACE.mediaWorkspace
	? ALL_MODES
	: ALL_MODES.filter((mode) => mode.id === "edit");

export function EditorTopBar({
	mode,
	onModeChange,
	projectTitle,
	dirty,
	canExport,
	canImportMedia,
	canRegenerateAutomaticEdits,
	regeneratingAutomaticEdits,
	importingMedia,
	chatOpen,
	readOnly,
	entitlementLabel,
	onEntitlement,
	actions,
}: EditorTopBarProps) {
	const { theme, toggle: toggleTheme } = useTheme();
	const t = useScopedT("editor");

	// ponytail: the left side panel only renders in "edit" mode (see
	// NewEditorShell body), so its toggle is meaningless in Media/Rec —
	// hide the button (and its separator) there to keep the topbar honest.
	const showChatToggle = PRODUCT_SURFACE.agentEditor && mode === "edit";
	return (
		<header className={styles.topbar}>
			{/* Fixed-width slot: the toggle is Edit-only, and .topbarLead holds its
			    space in the other modes so nothing to the right moves. */}
			<span className={styles.topbarLead}>
				{showChatToggle ? (
					<>
						<button
							type="button"
							className={`${styles.iconBtn}${chatOpen ? ` ${styles.on}` : ""}`}
							title={t("topbar.toggleChatPanel")}
							aria-label={t("topbar.toggleChatPanel")}
							aria-pressed={chatOpen}
							onClick={actions.toggleChat}
						>
							<PanelLeft size={17} />
						</button>
						<span className={styles.sep} aria-hidden />
					</>
				) : null}
			</span>
			<span className={styles.brand}>
				<KlipptMark className={styles.brandMark} />
			</span>
			<span className={styles.sep} aria-hidden />
			<ProjectNameField
				title={projectTitle}
				onRename={actions.renameProject}
				readOnly={readOnly}
				onReadOnly={onEntitlement}
			/>
			<span className={styles.sep} aria-hidden />
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.openProject")}
				aria-label={t("topbar.openProject")}
				onClick={actions.openProject}
			>
				<FolderOpen size={16} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.newProject")}
				aria-label={t("topbar.newProject")}
				onClick={actions.newProject}
			>
				<FolderPlus size={16} />
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("mediaStage.importMedia")}
				aria-label={t("mediaStage.importMedia")}
				onClick={actions.importMedia}
				disabled={!canImportMedia || importingMedia}
			>
				{importingMedia ? (
					<LoaderCircle size={16} className={styles.spin} aria-hidden />
				) : (
					<Film size={16} aria-hidden />
				)}
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.saveProject")}
				aria-label={t("topbar.saveProject")}
				onClick={actions.save}
				style={{ position: "relative" }}
			>
				<Save size={16} />
				{dirty ? (
					<span
						aria-hidden
						style={{
							position: "absolute",
							top: 5,
							right: 5,
							width: 6,
							height: 6,
							borderRadius: "50%",
							background: "var(--warn)",
						}}
					/>
				) : null}
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t(
					regeneratingAutomaticEdits
						? "topbar.regeneratingAutomaticEdits"
						: "topbar.regenerateAutomaticEdits",
				)}
				aria-label={t(
					regeneratingAutomaticEdits
						? "topbar.regeneratingAutomaticEdits"
						: "topbar.regenerateAutomaticEdits",
				)}
				onClick={actions.regenerateAutomaticEdits}
				disabled={!canRegenerateAutomaticEdits || regeneratingAutomaticEdits}
			>
				{regeneratingAutomaticEdits ? (
					<LoaderCircle size={16} className={styles.spin} aria-hidden />
				) : (
					<Sparkles size={16} aria-hidden />
				)}
			</button>
			<span className={styles.sep} aria-hidden />
			<LangButton />
			<span className={styles.saved} role="status" aria-live="polite" aria-atomic="true">
				<span className={styles.savedState} data-on={!dirty}>
					<Check size={12} strokeWidth={2} aria-hidden />
					{t("topbar.saved")}
				</span>
				<span className={styles.savedState} data-on={dirty} data-dirty="true">
					<Circle size={7} fill="currentColor" strokeWidth={0} aria-hidden />
					{t("topbar.unsaved")}
				</span>
			</span>

			<span className={styles.topbarSpacer} aria-hidden />
			{entitlementLabel ? (
				<button
					type="button"
					className={styles.entitlementStatus}
					onClick={onEntitlement}
					aria-label={entitlementLabel}
				>
					{readOnly ? <LockKeyhole size={12} aria-hidden /> : null}
					{entitlementLabel}
				</button>
			) : null}
			{MODES.length > 1 ? (
				<div className={styles.workspaceNav}>
					<div className={styles.modeSwitch} role="tablist" aria-label={t("topbar.editorMode")}>
						{MODES.map((m) => (
							<button
								key={m.id}
								type="button"
								role="tab"
								aria-selected={mode === m.id}
								data-label={t(m.labelKey)}
								onClick={() => onModeChange(m.id)}
							>
								<span className={styles.modeLabel}>{t(m.labelKey)}</span>
							</button>
						))}
					</div>
				</div>
			) : null}

			<button
				type="button"
				className={styles.iconBtn}
				title={theme === "dark" ? t("topbar.switchToLightTheme") : t("topbar.switchToDarkTheme")}
				aria-label={t("topbar.toggleTheme")}
				onClick={toggleTheme}
			>
				{theme === "dark" ? <Moon size={16} /> : <Sun size={16} />}
			</button>
			<button
				type="button"
				className={styles.iconBtn}
				title={t("topbar.settings")}
				aria-label={t("topbar.settings")}
				onClick={actions.openSettings}
			>
				<Settings size={16} />
			</button>
			<div className={styles.primaryActions}>
				<button
					type="button"
					className={styles.recordBtn}
					title={t("rec.startRecording")}
					aria-label={t("rec.startRecording")}
					onClick={actions.record}
				>
					<Circle size={10} fill="currentColor" strokeWidth={0} aria-hidden />
					{t("topbar.modes.rec")}
				</button>
				<button
					type="button"
					className={styles.exportBtn}
					title={t("topbar.export")}
					aria-label={t("topbar.export")}
					onClick={actions.export}
					disabled={!canExport}
				>
					<Download size={15} />
					{t("topbar.export")}
				</button>
			</div>
		</header>
	);
}

function ProjectNameField({
	title,
	onRename,
	readOnly,
	onReadOnly,
}: {
	title: string | null;
	onRename: (title: string) => void;
	readOnly: boolean;
	onReadOnly: () => void;
}) {
	const t = useScopedT("editor");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title ?? "");

	const startEditing = () => {
		if (readOnly) {
			onReadOnly();
			return;
		}
		setDraft(title ?? "");
		setEditing(true);
	};

	const commit = () => {
		setEditing(false);
		const next = draft.trim();
		if (next) onRename(next);
	};

	if (editing) {
		return (
			<input
				className={styles.projectNameInput}
				autoFocus
				value={draft}
				onFocus={(e) => e.currentTarget.select()}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					} else if (e.key === "Escape") {
						setEditing(false);
					}
				}}
			/>
		);
	}

	return (
		<button
			type="button"
			className={`${styles.ghostBtn} ${styles.projectNameBtn}`}
			aria-label={t("topbar.renameProject")}
			// The label is truncated to keep the slot fixed, so the full name has to
			// stay reachable on hover.
			title={title ?? undefined}
			disabled={!title}
			onClick={startEditing}
		>
			<span className={styles.projectNameLabel}>{title ?? t("topbar.noProject")}</span>
		</button>
	);
}

function LangButton() {
	const { locale, setLocale } = useI18n();
	const t = useScopedT("editor");
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) return;
		const onDocClick = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", onDocClick);
		return () => document.removeEventListener("mousedown", onDocClick);
	}, [open]);
	return (
		<div ref={ref} style={{ position: "relative", flexShrink: 0 }}>
			<button
				type="button"
				className={styles.iconBtn}
				style={{ width: "auto", padding: "0 8px", gap: 6, display: "inline-flex" }}
				onClick={() => setOpen((v) => !v)}
				aria-label={t("topbar.changeLanguage")}
				aria-pressed={open}
			>
				<Languages size={15} />
				{/* Fixed-width, centred: the short labels run from "EN" to "PT-BR" to
				    the CJK "简中", and letting the button size to them moved everything
				    to its right on each language change. */}
				<span className={styles.langShort}>{getLocaleShort(locale)}</span>
				<ChevronDown size={9} style={{ color: "var(--muted)" }} />
			</button>
			{open ? (
				<div
					style={{
						position: "absolute",
						top: "calc(100% + 4px)",
						right: 0,
						minWidth: 160,
						background: "var(--surface)",
						border: "1px solid var(--border)",
						borderRadius: "var(--r-md)",
						boxShadow: "var(--elev-pop)",
						padding: 4,
						zIndex: 60,
					}}
				>
					{getAvailableLocales().map((code) => (
						<button
							key={code}
							type="button"
							style={{
								display: "block",
								width: "100%",
								textAlign: "left",
								padding: "6px 10px",
								border: 0,
								background: code === locale ? "var(--accent-wash)" : "transparent",
								color: code === locale ? "var(--accent)" : "var(--fg-2)",
								borderRadius: "var(--r-sm)",
								cursor: "pointer",
								font: "500 12px var(--font-body)",
							}}
							onClick={() => {
								setLocale(code);
								setOpen(false);
							}}
						>
							{getLocaleName(code)}
						</button>
					))}
				</div>
			) : null}
		</div>
	);
}
