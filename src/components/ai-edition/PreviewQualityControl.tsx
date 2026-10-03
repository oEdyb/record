import { AppSelect } from "@/components/ui/app-select";
import { useScopedT } from "@/contexts/I18nContext";
import { usePreviewPreferences } from "@/lib/ai-edition/store/previewPreferences";
import styles from "./PreviewQualityControl.module.css";

export function PreviewQualityControl() {
	const t = useScopedT("editor");
	const { quality, setQuality } = usePreviewPreferences();
	return (
		<div className={styles.control}>
			<label htmlFor="preview-quality">{t("previewQuality.label")}</label>
			<AppSelect
				id="preview-quality"
				aria-label={t("previewQuality.label")}
				value={quality}
				onChange={({ target }) => {
					if (target.value === "sharp" || target.value === "performance") setQuality(target.value);
				}}
			>
				<option value="sharp">{t("previewQuality.sharp")}</option>
				<option value="performance">{t("previewQuality.performance")}</option>
			</AppSelect>
		</div>
	);
}
