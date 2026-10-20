import { Keyboard, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useScopedT } from "@/contexts/I18nContext";
import { useShortcuts, useShortcutsDialogState } from "@/contexts/ShortcutsContext";
import {
	DEFAULT_SHORTCUTS,
	FIXED_SHORTCUTS,
	findConflict,
	formatBinding,
	SHORTCUT_ACTIONS,
	type ShortcutAction,
	type ShortcutBinding,
	type ShortcutConflict,
	type ShortcutsConfig,
} from "@/lib/shortcuts";
import styles from "./ShortcutsConfigDialog.module.css";

const MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

export function ShortcutsConfigDialog() {
	const { shortcuts, isMac, closeConfig, setShortcuts, persistShortcuts } = useShortcuts();
	const isConfigOpen = useShortcutsDialogState();
	const t = useScopedT("shortcuts");
	const tc = useScopedT("common");

	const [draft, setDraft] = useState<ShortcutsConfig>(shortcuts);
	const [captureFor, setCaptureFor] = useState<ShortcutAction | null>(null);
	const [conflict, setConflict] = useState<{
		forAction: ShortcutAction;
		pending: ShortcutBinding;
		conflictWith: ShortcutConflict;
	} | null>(null);

	useEffect(() => {
		if (isConfigOpen) {
			setDraft(shortcuts);
			setCaptureFor(null);
			setConflict(null);
		}
	}, [isConfigOpen, shortcuts]);

	useEffect(() => {
		if (!captureFor) return;

		const handleCapture = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();

			if (e.key === "Escape") {
				setCaptureFor(null);
				return;
			}

			if (MODIFIER_KEYS.has(e.key)) return;

			const binding: ShortcutBinding = {
				key: e.key.toLowerCase(),
				...(e.ctrlKey || e.metaKey ? { ctrl: true } : {}),
				...(e.shiftKey ? { shift: true } : {}),
				...(e.altKey ? { alt: true } : {}),
			};

			const found = findConflict(binding, captureFor, draft);
			setCaptureFor(null);

			if (found?.type === "fixed") {
				toast.error(
					t("reservedShortcut", {
						label: t(`fixedActions.${found.i18nKey}`, { defaultValue: found.label }),
					}),
				);
				return;
			}

			if (found?.type === "configurable") {
				setConflict({ forAction: captureFor, pending: binding, conflictWith: found });
				return;
			}

			setDraft((prev: ShortcutsConfig) => ({ ...prev, [captureFor]: binding }));
		};

		window.addEventListener("keydown", handleCapture, { capture: true });
		return () => window.removeEventListener("keydown", handleCapture, { capture: true });
	}, [captureFor, draft, t]);

	const handleSwap = useCallback(() => {
		if (!conflict || conflict.conflictWith.type !== "configurable") return;
		const { forAction, pending, conflictWith } = conflict;
		setDraft((prev: ShortcutsConfig) => ({
			...prev,
			[forAction]: pending,
			[conflictWith.action]: prev[forAction],
		}));
		setConflict(null);
	}, [conflict]);

	const handleCancelConflict = useCallback(() => setConflict(null), []);

	const handleSave = useCallback(async () => {
		const success = await persistShortcuts(draft);
		if (success) {
			setShortcuts(draft);
			toast.success(t("savedToast"));
			closeConfig();
		} else {
			toast.error(t("registrationFailed"));
		}
	}, [draft, setShortcuts, persistShortcuts, closeConfig, t]);

	const handleReset = useCallback(() => {
		setDraft({ ...DEFAULT_SHORTCUTS });
		toast.info(t("resetToast"));
	}, [t]);

	const handleClose = useCallback(() => {
		setCaptureFor(null);
		setConflict(null);
		closeConfig();
	}, [closeConfig]);

	return (
		<Dialog
			open={isConfigOpen}
			onOpenChange={(open: boolean) => {
				if (!open) handleClose();
			}}
		>
			<DialogContent size="sm" aria-describedby={undefined}>
				<DialogHeader>
					<DialogTitle className={styles.title}>
						<Keyboard />
						{t("title")}
					</DialogTitle>
				</DialogHeader>

				<DialogBody className={styles.body}>
					<section className={styles.section}>
						<p className={styles.sectionLabel}>{t("configurable")}</p>
						{SHORTCUT_ACTIONS.map((action) => {
							const isCapturing = captureFor === action;
							const hasConflict = conflict?.forAction === action;
							return (
								<div key={action}>
									<div className={styles.row}>
										<span className={styles.label}>{t(`actions.${action}`)}</span>
										<button
											type="button"
											onClick={() => {
												setConflict(null);
												setCaptureFor(isCapturing ? null : action);
											}}
											title={isCapturing ? t("pressEscToCancel") : t("clickToChange")}
											className={`${styles.binding} ${
												isCapturing ? styles.capturing : hasConflict ? styles.conflicted : ""
											}`}
										>
											{isCapturing ? t("pressKey") : formatBinding(draft[action], isMac)}
										</button>
									</div>
									{hasConflict && conflict?.conflictWith.type === "configurable" && (
										<div className={styles.conflict}>
											<span>
												⚠{" "}
												{t("alreadyUsedBy", {
													action: t(`actions.${conflict.conflictWith.action}`),
												})}
											</span>
											<div className={styles.conflictActions}>
												<button
													type="button"
													onClick={handleSwap}
													className={styles.conflictAction}
												>
													{t("swap")}
												</button>
												<button
													type="button"
													onClick={handleCancelConflict}
													className={styles.conflictAction}
												>
													{tc("actions.cancel")}
												</button>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</section>

					<section className={styles.section}>
						<p className={styles.sectionLabel}>{t("fixed")}</p>
						{FIXED_SHORTCUTS.map(({ i18nKey, label, bindings }) => (
							<div key={i18nKey} className={styles.row}>
								<span className={`${styles.label} ${styles.fixedLabel}`}>
									{t(`fixedActions.${i18nKey}`, { defaultValue: label })}
								</span>
								<kbd className={`${styles.binding} ${styles.fixedBinding}`}>
									{bindings.map((binding) => formatBinding(binding, isMac)).join(" / ")}
								</kbd>
							</div>
						))}
					</section>

					<p className={styles.help}>{t("helpText")}</p>
				</DialogBody>

				<DialogFooter className={styles.footer}>
					<Button variant="ghost" size="sm" className={styles.reset} onClick={handleReset}>
						<RotateCcw />
						{t("resetToDefaults")}
					</Button>
					<div className={styles.footerActions}>
						<Button variant="ghost" size="sm" onClick={handleClose}>
							{tc("actions.cancel")}
						</Button>
						<Button size="sm" className={styles.save} onClick={handleSave}>
							{tc("actions.save")}
						</Button>
					</div>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
