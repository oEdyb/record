import { AlertTriangle, FolderOpen, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	Dialog,
	DialogBody,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogHeading,
	DialogTitle,
} from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import styles from "./ReviewSurface.module.css";

interface BaseModalProps {
	open: boolean;
	onClose: () => void;
}

export function ModalShell({
	open,
	onClose,
	title,
	subtitle,
	size = "md",
	children,
}: BaseModalProps & {
	title: string;
	subtitle?: string;
	size?: "sm" | "md" | "lg" | "xl";
	children: ReactNode;
}) {
	const tc = useScopedT("common");
	const openerRef = useRef<HTMLElement | null>(null);
	return (
		<Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
			<DialogContent
				size={size}
				showCloseButton={false}
				onOpenAutoFocus={() => {
					openerRef.current =
						document.activeElement instanceof HTMLElement ? document.activeElement : null;
				}}
				onCloseAutoFocus={(event) => {
					if (!openerRef.current?.isConnected) return;
					event.preventDefault();
					openerRef.current.focus({ preventScroll: true });
				}}
			>
				<DialogHeader>
					<DialogHeading>
						<DialogTitle>{title}</DialogTitle>
						{subtitle ? <DialogDescription>{subtitle}</DialogDescription> : null}
					</DialogHeading>
					<DialogClose asChild>
						<button
							type="button"
							className={styles.closeBtn}
							title={tc("actions.close")}
							aria-label={tc("actions.close")}
						>
							<X size={16} />
						</button>
					</DialogClose>
				</DialogHeader>
				<DialogBody className={styles.modalBody}>{children}</DialogBody>
			</DialogContent>
		</Dialog>
	);
}

const UPDATED_AT_FORMAT = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

interface ProjectItem {
	id: string;
	title: string;
	updatedAt: string;
}

interface OpenProjectModalProps extends BaseModalProps {
	projects: ProjectItem[];
	loading?: boolean;
	loadFailed?: boolean;
	recordingOnly?: boolean;
	allowDelete?: boolean;
	allowImport?: boolean;
	activeProjectId: string | null;
	onSelect: (id: string) => void;
	onDelete: (id: string) => void;
	onBrowse: () => void;
}

export function OpenProjectModal({
	open,
	onClose,
	projects,
	loading = false,
	loadFailed = false,
	recordingOnly = false,
	allowDelete = true,
	allowImport = true,
	activeProjectId,
	onSelect,
	onDelete,
	onBrowse,
}: OpenProjectModalProps) {
	const t = useScopedT("editor");
	const tc = useScopedT("common");
	const [query, setQuery] = useState("");
	const searchRef = useRef<HTMLInputElement>(null);
	const rowRefs = useRef(new Map<string, HTMLButtonElement>());
	const cancelConfirmRef = useRef<HTMLButtonElement>(null);
	const confirmReturnFocusRef = useRef<HTMLElement | null>(null);
	const previousConfirmId = useRef<string | null>(null);
	// Deleting a project cannot be undone, so the trash icon arms an inline
	// confirm on its own row instead of deleting on the first click. One row at a
	// time, and closing the dialog disarms it.
	const [confirmId, setConfirmId] = useState<string | null>(null);
	useEffect(() => {
		if (!open) {
			setConfirmId(null);
			setQuery("");
		}
	}, [open]);
	useEffect(() => {
		if (confirmId) {
			if (!previousConfirmId.current) cancelConfirmRef.current?.focus();
		} else if (previousConfirmId.current && open) {
			const target = confirmReturnFocusRef.current;
			if (target?.isConnected) target.focus({ preventScroll: true });
			else searchRef.current?.focus({ preventScroll: true });
			confirmReturnFocusRef.current = null;
		}
		previousConfirmId.current = confirmId;
	}, [confirmId, open]);
	const filtered =
		loading || loadFailed
			? []
			: projects.filter((p) => p.title.toLowerCase().includes(query.trim().toLowerCase()));
	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t(recordingOnly ? "recordingReview.recordings" : "openProjectDialog.title")}
			subtitle={t(recordingOnly ? "recordingReview.libraryHint" : "openProjectDialog.subtitle")}
			size="lg"
		>
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 8,
					marginBottom: 12,
				}}
			>
				<FolderOpen size={14} style={{ color: "var(--muted)" }} />
				<input
					ref={searchRef}
					type="search"
					className={styles.modalSearchInput}
					aria-label={t(
						recordingOnly
							? "recordingReview.searchRecordings"
							: "openProjectDialog.searchPlaceholder",
					)}
					data-dialog-initial-focus
					placeholder={t(
						recordingOnly
							? "recordingReview.searchRecordings"
							: "openProjectDialog.searchPlaceholder",
					)}
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					onKeyDown={(event) => {
						if (
							event.nativeEvent.isComposing ||
							event.altKey ||
							event.ctrlKey ||
							event.metaKey ||
							event.shiftKey
						)
							return;
						const available = filtered.filter((project) => project.id !== confirmId);
						const target = event.key === "ArrowUp" ? available.at(-1) : available[0];
						if (!target) return;
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							rowRefs.current.get(target.id)?.focus();
						} else if (event.key === "Enter" && !event.repeat) {
							event.preventDefault();
							onSelect(target.id);
							onClose();
						}
					}}
					style={{
						flex: 1,
						height: 36,
						padding: "0 12px",
						border: "1px solid var(--border)",
						borderRadius: "var(--r-md)",
						background: "var(--surface)",
						color: "var(--fg)",
						font: "400 13px/1 var(--font-body)",
						outline: "none",
					}}
				/>
			</div>
			<div
				aria-busy={loading}
				style={{
					display: "flex",
					flexDirection: "column",
					gap: 2,
					marginBottom: 12,
					// Cap the list so the footer's "Browse files" button stays visible
					// instead of being pushed below the fold when there are many projects;
					// the list scrolls internally. A fixed height keeps the dialog from
					// jumping when the list replaces the loading line.
					height: "min(48vh, 420px)",
					overflowY: "auto",
					scrollbarWidth: "thin",
					scrollbarColor: "var(--border-hi) transparent",
				}}
			>
				{filtered.length === 0 ? (
					<p
						role={loadFailed ? "alert" : "status"}
						style={{
							color: "var(--muted)",
							fontSize: 12,
							padding: 16,
							margin: "auto 0",
							textAlign: "center",
						}}
					>
						{loading
							? t("rec.loading")
							: loadFailed
								? t(recordingOnly ? "recordingReview.loadRecordingsFailed" : "project.failedToLoad")
								: recordingOnly && projects.length === 0
									? t("recordingReview.libraryEmpty")
									: t(recordingOnly ? "recordingReview.noMatches" : "openProjectDialog.noMatches", {
											query,
										})}
					</p>
				) : (
					filtered.map((p) => {
						const isActive = p.id === activeProjectId;
						return (
							<div key={p.id} style={{ display: "contents" }}>
								{p.id === confirmId ? (
									<div
										style={{
											display: "flex",
											alignItems: "center",
											gap: 8,
											padding: "10px 12px",
											borderRadius: "var(--r-md)",
											background: "var(--danger-soft)",
											boxShadow: "inset 0 0 0 1px var(--danger-hatch)",
										}}
									>
										<div style={{ minWidth: 0, flex: 1 }}>
											<div
												style={{
													font: "500 13px/1.3 var(--font-body)",
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												}}
											>
												{p.title}
											</div>
											<div
												style={{
													font: "400 11px/1.4 var(--font-body)",
													color: "var(--muted)",
													marginTop: 2,
												}}
											>
												{t("openProjectDialog.confirmDelete")}
											</div>
										</div>
										<button
											ref={cancelConfirmRef}
											type="button"
											className={`${styles.btn} ${styles.btnSecondary}`}
											onClick={() => setConfirmId(null)}
										>
											{tc("actions.cancel")}
										</button>
										<button
											type="button"
											className={`${styles.btn} ${styles.dangerBtn}`}
											onClick={() => {
												const index = filtered.findIndex((project) => project.id === p.id);
												const adjacentProject = filtered[index + 1] ?? filtered[index - 1];
												confirmReturnFocusRef.current = adjacentProject
													? (rowRefs.current.get(adjacentProject.id) ?? searchRef.current)
													: searchRef.current;
												setConfirmId(null);
												onDelete(p.id);
											}}
										>
											<Trash2 size={14} />
											{tc("actions.delete")}
										</button>
									</div>
								) : null}
								<div
									style={
										p.id === confirmId
											? { display: "none" }
											: {
													display: "flex",
													alignItems: "center",
													gap: 4,
													contentVisibility: "auto",
													containIntrinsicSize: "auto 60px",
												}
									}
								>
									<button
										type="button"
										ref={(element) => {
											if (element) rowRefs.current.set(p.id, element);
											else rowRefs.current.delete(p.id);
										}}
										onKeyDown={(event) => {
											if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
											if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
											event.preventDefault();
											const available = filtered.filter((project) => project.id !== confirmId);
											const index = available.findIndex((project) => project.id === p.id);
											const next = available[index + (event.key === "ArrowDown" ? 1 : -1)];
											if (next) rowRefs.current.get(next.id)?.focus();
											else searchRef.current?.focus();
										}}
										onClick={() => {
											onSelect(p.id);
											onClose();
										}}
										style={{
											flex: 1,
											minWidth: 0,
											display: "grid",
											gridTemplateColumns: "36px 1fr auto",
											alignItems: "center",
											gap: 12,
											padding: "10px 12px",
											border: "none",
											borderRadius: "var(--r-md)",
											background: isActive ? "var(--accent-wash)" : "transparent",
											boxShadow: isActive ? "inset 0 0 0 1px var(--accent)" : "none",
											color: "var(--fg)",
											cursor: "pointer",
											textAlign: "left",
											font: "inherit",
										}}
									>
										<div
											style={{
												width: 36,
												height: 36,
												borderRadius: "var(--r-sm)",
												background: "linear-gradient(135deg, var(--brand-lo), var(--brand))",
												display: "grid",
												placeItems: "center",
												color: "var(--accent-on)",
											}}
										>
											<FolderOpen size={18} />
										</div>
										<div style={{ minWidth: 0 }}>
											<div
												style={{
													font: "500 13px/1.3 var(--font-body)",
													overflow: "hidden",
													textOverflow: "ellipsis",
													whiteSpace: "nowrap",
												}}
											>
												{p.title}
											</div>
										</div>
										<span
											style={{
												font: "400 11px/1 var(--font-mono)",
												color: "var(--meta)",
												whiteSpace: "nowrap",
											}}
										>
											{UPDATED_AT_FORMAT.format(new Date(p.updatedAt))}
										</span>
									</button>
									{allowDelete ? (
										<button
											type="button"
											className={styles.iconBtn}
											onClick={(event) => {
												confirmReturnFocusRef.current = event.currentTarget;
												setConfirmId(p.id);
											}}
											title={t("openProjectDialog.deleteProject")}
											aria-label={t("openProjectDialog.deleteProject")}
										>
											<Trash2 size={14} />
										</button>
									) : null}
								</div>
							</div>
						);
					})
				)}
			</div>
			<div
				style={{
					display: "flex",
					justifyContent: "space-between",
					alignItems: "center",
					flexWrap: "wrap",
					gap: 12,
					paddingTop: 12,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<span style={{ fontSize: 12, color: "var(--muted)", whiteSpace: "nowrap" }}>
					<kbd
						style={{
							font: "500 11px/1 var(--font-mono)",
							padding: "2px 6px",
							borderRadius: 4,
							background: "var(--surface-2)",
							border: "1px solid var(--border)",
							color: "var(--fg)",
						}}
					>
						↑↓
					</kbd>{" "}
					{t("openProjectDialog.navigateHint")}{" "}
					<kbd
						style={{
							font: "500 11px/1 var(--font-mono)",
							padding: "2px 6px",
							borderRadius: 4,
							background: "var(--surface-2)",
							border: "1px solid var(--border)",
							color: "var(--fg)",
						}}
					>
						Enter
					</kbd>{" "}
					{t("openProjectDialog.openHint")}
				</span>
				{allowImport ? (
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						style={{ whiteSpace: "nowrap", flexShrink: 0, marginLeft: "auto" }}
						onClick={() => {
							onBrowse();
							onClose();
						}}
					>
						<FolderOpen size={14} />
						{t("openProjectDialog.browseFiles")}
					</button>
				) : null}
			</div>
		</ModalShell>
	);
}

export type UnsavedChoice = "save" | "discard" | "cancel";

interface UnsavedChangesModalProps extends BaseModalProps {
	action: "close" | "new" | "open" | "record";
	busy?: boolean;
	onChoose: (choice: UnsavedChoice) => void;
}

export function UnsavedChangesModal({
	open,
	onClose,
	action,
	busy,
	onChoose,
}: UnsavedChangesModalProps) {
	const td = useScopedT("dialogs");
	const tc = useScopedT("common");
	const titleKeys: Record<UnsavedChangesModalProps["action"], string> = {
		close: "modal.closeTitle",
		new: "modal.newTitle",
		open: "modal.openTitle",
		record: "modal.recordTitle",
	};
	const copy = {
		title: td(titleKeys[action]),
		body: action === "close" ? td("modal.closeBody") : td("modal.sharedBody"),
	};
	return (
		<ModalShell open={open} onClose={onClose} title={copy.title} subtitle={copy.body} size="md">
			<div
				style={{
					display: "flex",
					alignItems: "center",
					gap: 10,
					marginBottom: 4,
				}}
			>
				<span
					style={{
						display: "grid",
						placeItems: "center",
						width: 32,
						height: 32,
						borderRadius: 8,
						background: "var(--warn-soft)",
						color: "var(--warn)",
					}}
				>
					<AlertTriangle size={16} />
				</span>
				<div
					style={{
						font: "500 12px var(--font-body)",
						color: "var(--fg-2)",
					}}
				>
					{td("modal.notSavedYet")}
				</div>
			</div>
			<div
				style={{
					display: "flex",
					justifyContent: "flex-end",
					gap: 8,
					paddingTop: 12,
					borderTop: "1px solid var(--border-soft)",
				}}
			>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={() => onChoose("cancel")}
					disabled={busy}
				>
					{tc("actions.cancel")}
				</button>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					onClick={() => onChoose("discard")}
					disabled={busy}
				>
					{td("modal.discard")}
				</button>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnPrimary}`}
					onClick={() => onChoose("save")}
					disabled={busy}
				>
					{busy ? td("modal.saving") : td("modal.saveAndContinue")}
				</button>
			</div>
		</ModalShell>
	);
}
