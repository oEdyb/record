import { Film, FolderOpen, Search, Trash2, X } from "lucide-react";
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
import modal from "./Modals.module.css";
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
	className,
	children,
}: BaseModalProps & {
	title: string;
	subtitle?: string;
	size?: "sm" | "md" | "lg" | "xl";
	className?: string;
	children: ReactNode;
}) {
	const tc = useScopedT("common");
	const openerRef = useRef<HTMLElement | null>(null);
	return (
		<Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
			<DialogContent
				size={size}
				className={className}
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
			className={modal.library}
		>
			<label className={modal.search}>
				<Search size={15} aria-hidden="true" />
				<input
					ref={searchRef}
					type="search"
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
				/>
			</label>
			{/* A fixed height keeps the dialog from jumping when the list replaces the loading
			    line, and keeps Browse files visible however many recordings there are. */}
			<div aria-busy={loading} className={modal.list}>
				{filtered.length === 0 ? (
					<p role={loadFailed ? "alert" : "status"} className={modal.empty}>
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
									<div className={modal.confirm}>
										<div className={modal.rowText}>
											<div className={modal.rowTitle}>{p.title}</div>
											<div className={modal.confirmText}>
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
									className={modal.rowWrap}
									style={p.id === confirmId ? { display: "none" } : undefined}
								>
									<button
										type="button"
										className={modal.row}
										data-active={isActive || undefined}
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
									>
										<span className={modal.rowIcon} aria-hidden="true">
											<Film size={16} />
										</span>
										<span className={modal.rowTitle}>{p.title}</span>
										<span className={modal.rowDate}>
											{UPDATED_AT_FORMAT.format(new Date(p.updatedAt))}
										</span>
									</button>
									{allowDelete ? (
										<button
											type="button"
											className={`${styles.iconBtn} ${modal.rowDelete}`}
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
			<div className={modal.footer}>
				<span className={modal.keys}>
					<kbd>↑↓</kbd> {t("openProjectDialog.navigateHint")} <kbd>↩</kbd>{" "}
					{t("openProjectDialog.openHint")}
				</span>
				{allowImport ? (
					<button
						type="button"
						className={`${styles.btn} ${styles.btnSecondary}`}
						onClick={() => {
							onBrowse();
							onClose();
						}}
					>
						<FolderOpen size={15} />
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
		close: "unsavedChanges.modal.closeTitle",
		new: "unsavedChanges.modal.newTitle",
		open: "unsavedChanges.modal.openTitle",
		record: "unsavedChanges.modal.recordTitle",
	};
	const copy = {
		title: td(titleKeys[action]),
		body:
			action === "close"
				? td("unsavedChanges.modal.closeBody")
				: td("unsavedChanges.modal.sharedBody"),
	};
	return (
		<ModalShell open={open} onClose={onClose} title={copy.title} subtitle={copy.body} size="md">
			<div className={modal.footer} data-align="end">
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
					className={`${styles.btn} ${styles.dangerBtn}`}
					onClick={() => onChoose("discard")}
					disabled={busy}
				>
					{td("unsavedChanges.modal.discard")}
				</button>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnPrimary}`}
					onClick={() => onChoose("save")}
					disabled={busy}
				>
					{busy ? td("unsavedChanges.modal.saving") : td("unsavedChanges.modal.saveAndContinue")}
				</button>
			</div>
		</ModalShell>
	);
}
