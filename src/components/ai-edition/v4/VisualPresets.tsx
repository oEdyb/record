import { Bookmark, ChevronDown, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	applyVisualPreset,
	BUILTIN_VISUAL_PRESETS,
	captureVisualPreset,
	loadVisualPresets,
	saveVisualPresets,
	type VisualPreset,
} from "@/lib/ai-edition/store/visualPresets";
import styles from "./VisualPresets.module.css";

export function VisualPresets({ readOnly }: { readOnly: boolean }) {
	const t = useScopedT("editor");
	const hasDocument = useProjectStore((state) => state.document !== null);
	const [open, setOpen] = useState(false);
	const [presets, setPresets] = useState<VisualPreset[]>([]);
	const [name, setName] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const inputId = useId();
	const disabled = readOnly || !hasDocument || busy;
	const apply = async (preset: VisualPreset) => {
		if (disabled) return;
		const state = useProjectStore.getState();
		if (!state.document) return;
		setError("");
		setBusy(true);
		try {
			const next = applyVisualPreset(state.document, preset);
			if (!(await state.saveDocumentAsEdit(next, state.document))) {
				setError(t("visualPresets.applyFailed"));
				return;
			}
			setOpen(false);
		} catch {
			setError(t("visualPresets.applyFailed"));
		} finally {
			setBusy(false);
		}
	};
	const save = () => {
		const document = useProjectStore.getState().document;
		if (disabled || !document) return;
		setError("");
		if (
			[...BUILTIN_VISUAL_PRESETS, ...presets].some(
				(preset) => preset.name.toLocaleLowerCase() === name.trim().toLocaleLowerCase(),
			)
		) {
			setError(t("visualPresets.duplicate"));
			return;
		}
		let preset: VisualPreset;
		try {
			preset = captureVisualPreset(document, name, crypto.randomUUID());
		} catch {
			setError(t("visualPresets.unsupported"));
			return;
		}
		try {
			const next = [...presets, preset];
			saveVisualPresets(next);
			setPresets(next);
			setName("");
		} catch {
			setError(t("visualPresets.saveFailed"));
		}
	};
	const remove = (id: string) => {
		try {
			const next = presets.filter((preset) => preset.id !== id);
			saveVisualPresets(next);
			setPresets(next);
			setError("");
		} catch {
			setError(t("visualPresets.saveFailed"));
		}
	};
	const label = (preset: VisualPreset) =>
		preset.id === "builtin-clean"
			? t("visualPresets.clean")
			: preset.id === "builtin-contrast"
				? t("visualPresets.contrast")
				: preset.name;
	return (
		<Popover
			open={open}
			onOpenChange={(value) => {
				if (busy) return;
				setOpen(value);
				setError("");
				if (value) {
					setPresets(loadVisualPresets());
					setName("");
				}
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					className={styles.trigger}
					disabled={readOnly || !hasDocument}
					aria-label={t("visualPresets.title")}
				>
					<Bookmark size={14} aria-hidden />
					{t("visualPresets.title")}
					<ChevronDown size={12} aria-hidden />
				</button>
			</PopoverTrigger>
			<PopoverContent
				className={styles.panel}
				align="end"
				animated={false}
				aria-label={t("visualPresets.title")}
				collisionPadding={12}
			>
				<h2>{t("visualPresets.title")}</h2>
				<p className={styles.scope}>{t("visualPresets.scope")}</p>
				<div className={styles.list}>
					{[...BUILTIN_VISUAL_PRESETS, ...presets].map((preset) => (
						<div key={preset.id} className={styles.row}>
							<button
								type="button"
								className={styles.choice}
								disabled={disabled}
								onClick={() => void apply(preset)}
							>
								<Bookmark size={15} aria-hidden />
								<span>{label(preset)}</span>
							</button>
							{presets.includes(preset) && (
								<button
									type="button"
									className={styles.remove}
									disabled={disabled}
									onClick={() => remove(preset.id)}
									aria-label={t("visualPresets.remove", { name: preset.name })}
								>
									<Trash2 size={14} aria-hidden />
								</button>
							)}
						</div>
					))}
				</div>
				<form
					className={styles.save}
					onSubmit={(event) => {
						event.preventDefault();
						save();
					}}
				>
					<label htmlFor={inputId}>{t("visualPresets.saveCurrent")}</label>
					<div className={styles.saveRow}>
						<input
							id={inputId}
							value={name}
							maxLength={48}
							disabled={disabled || presets.length >= 20}
							onChange={(event) => setName(event.target.value)}
							placeholder={t("visualPresets.name")}
						/>
						<button type="submit" disabled={disabled || !name.trim() || presets.length >= 20}>
							{t("visualPresets.save")}
						</button>
					</div>
					{presets.length >= 20 && <p className={styles.scope}>{t("visualPresets.limit")}</p>}
				</form>
				{error && (
					<p role="alert" className={styles.error}>
						{error}
					</p>
				)}
			</PopoverContent>
		</Popover>
	);
}
