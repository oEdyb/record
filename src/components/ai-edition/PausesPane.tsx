import { AudioLines, Check, ChevronDown, Loader2, Play, Save, Scissors } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { useScopedT } from "@/contexts/I18nContext";
import { applyPauseSuggestions } from "@/lib/ai-edition/document/pause-edits";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	type PauseAnalysisPolicy,
	type PausePresetId,
	type PauseSuggestion,
} from "@/lib/ai-edition/timeline/pause-analysis";
import styles from "./NewEditorShell.module.css";
import {
	analyzeProjectPauses,
	type ProjectPauseAnalysisResult,
} from "./pauses/analyzeProjectPauses";
import {
	loadPausePolicy,
	loadSavedPausePresets,
	policyForBuiltInPausePreset,
	type SavedPausePreset,
	savePausePolicy,
	savePausePreset,
} from "./pauses/pausePreferences";
import { Pane, SliderCell, Toggle } from "./RightPanes";

export interface SelectablePauseSuggestion extends PauseSuggestion {
	selected: boolean;
}

interface PausesPaneProps {
	suggestions: SelectablePauseSuggestion[];
	onSuggestionsChange: (suggestions: SelectablePauseSuggestion[]) => void;
	onPreview: (suggestions: SelectablePauseSuggestion[] | null) => void;
}

const BUILT_IN_PRESETS: Array<{ id: PausePresetId; key: "natural" | "balanced" | "tight" }> = [
	{ id: "natural", key: "natural" },
	{ id: "balanced", key: "balanced" },
	{ id: "tight", key: "tight" },
];

function seconds(value: number): string {
	return `${value.toFixed(value < 1 ? 2 : 1)} s`;
}

export function PausesPane({ suggestions, onSuggestionsChange, onPreview }: PausesPaneProps) {
	const ts = useScopedT("settings");
	const document = useProjectStore((state) => state.document);
	const projectId = useProjectStore((state) => state.projectId);
	const applyDocumentPatch = useProjectStore((state) => state.applyDocumentPatch);
	const [policy, setPolicy] = useState<PauseAnalysisPolicy>(loadPausePolicy);
	const [status, setStatus] = useState<"idle" | "analyzing" | "applying" | "error">("idle");
	const [analysis, setAnalysis] = useState<ProjectPauseAnalysisResult | null>(null);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [previewing, setPreviewing] = useState(false);
	const [savedPresets, setSavedPresets] = useState<SavedPausePreset[]>(loadSavedPausePresets);
	const [presetName, setPresetName] = useState("");
	const [saveOpen, setSaveOpen] = useState(false);

	const updatePolicy = useCallback((patch: Partial<PauseAnalysisPolicy>) => {
		setPolicy((current) => {
			const next = { ...current, ...patch };
			savePausePolicy(next);
			return next;
		});
	}, []);

	useEffect(() => {
		if (!document || !projectId) {
			onSuggestionsChange([]);
			return;
		}
		setPreviewing(false);
		onPreview(null);
		const controller = new AbortController();
		const timer = window.setTimeout(() => {
			setStatus("analyzing");
			void analyzeProjectPauses(document, policy, controller.signal)
				.then((next) => {
					if (controller.signal.aborted) return;
					setAnalysis(next);
					onSuggestionsChange(
						next.suggestions.map((suggestion) => ({ ...suggestion, selected: true })),
					);
					setStatus("idle");
				})
				.catch((error: unknown) => {
					if (controller.signal.aborted) return;
					console.error("Pause analysis failed", error);
					setStatus("error");
				});
		}, 220);
		return () => {
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [document, onPreview, onSuggestionsChange, policy, projectId]);

	useEffect(
		() => () => {
			onPreview(null);
			onSuggestionsChange([]);
		},
		[onPreview, onSuggestionsChange],
	);

	const selected = useMemo(
		() => suggestions.filter((suggestion) => suggestion.selected),
		[suggestions],
	);
	const savedSec = selected.reduce((total, suggestion) => total + suggestion.savedSec, 0);
	useEffect(() => {
		if (previewing) onPreview(selected);
	}, [onPreview, previewing, selected]);

	const applySelected = useCallback(async () => {
		if (!projectId || selected.length === 0) return;
		setStatus("applying");
		onPreview(null);
		setPreviewing(false);
		const result = await applyDocumentPatch(
			projectId,
			(current) => applyPauseSuggestions(current, selected),
			{ createHistorySnapshot: (current) => current },
		);
		if (result === "applied") {
			toast.success(ts("pauses.applied", { count: selected.length }));
			setStatus("idle");
			return;
		}
		if (result === "unchanged") {
			toast.info(ts("pauses.nothingToApply"));
			setStatus("idle");
			return;
		}
		toast.error(ts("pauses.applyFailed"));
		setStatus("error");
	}, [applyDocumentPatch, onPreview, projectId, selected, ts]);

	const togglePreview = () => {
		const next = !previewing;
		setPreviewing(next);
		onPreview(next ? selected : null);
	};

	const busy = status === "analyzing" || status === "applying";
	const allSelected = suggestions.length > 0 && selected.length === suggestions.length;

	return (
		<Pane
			title={ts("pauses.title")}
			icon={<AudioLines size={16} />}
			helpText={ts("pauses.help")}
			flat
		>
			<div className={styles.pauseInspector}>
				<label className={styles.inspectorSelectField}>
					<span>{ts("pauses.mode")}</span>
					<select
						value={policy.mode}
						onChange={(event) =>
							updatePolicy({ mode: event.target.value as PauseAnalysisPolicy["mode"] })
						}
					>
						<option value="speech">{ts("pauses.modeSpeech")}</option>
						<option value="audio-level">{ts("pauses.modeAudioLevel")}</option>
					</select>
				</label>

				<div className={styles.pausePresetRow}>
					{BUILT_IN_PRESETS.map((preset) => (
						<button
							key={preset.id}
							type="button"
							onClick={() => updatePolicy(policyForBuiltInPausePreset(preset.id, policy))}
							className={
								Math.abs(
									policy.minimumPauseSec -
										policyForBuiltInPausePreset(preset.id, policy).minimumPauseSec,
								) < 0.001 &&
								Math.abs(
									policy.shortenedPauseSec -
										policyForBuiltInPausePreset(preset.id, policy).shortenedPauseSec,
								) < 0.001
									? styles.pausePresetActive
									: undefined
							}
						>
							{ts(`pauses.${preset.key}`)}
						</button>
					))}
				</div>

				<SliderCell
					label={ts("pauses.longerThan")}
					value={policy.minimumPauseSec}
					min={0.25}
					max={5}
					step={0.05}
					decimals={2}
					suffix=" s"
					onChange={(minimumPauseSec) => updatePolicy({ minimumPauseSec })}
					onCommit={() => undefined}
					flat
				/>
				<SliderCell
					label={ts("pauses.shortenTo")}
					value={policy.shortenedPauseSec}
					min={0.05}
					max={1.5}
					step={0.05}
					decimals={2}
					suffix=" s"
					onChange={(shortenedPauseSec) => updatePolicy({ shortenedPauseSec })}
					onCommit={() => undefined}
					flat
				/>

				<button
					type="button"
					className={styles.pauseAdvancedButton}
					onClick={() => setAdvancedOpen((open) => !open)}
					aria-expanded={advancedOpen}
				>
					{ts("pauses.advanced")}
					<ChevronDown size={14} style={{ rotate: advancedOpen ? "180deg" : undefined }} />
				</button>

				{advancedOpen ? (
					<div className={styles.pauseAdvanced}>
						<SliderCell
							label={ts("pauses.sensitivity")}
							value={policy.sensitivity * 100}
							min={0}
							max={100}
							step={1}
							suffix="%"
							onChange={(value) => updatePolicy({ sensitivity: value / 100 })}
							onCommit={() => undefined}
							flat
						/>
						<SliderCell
							label={ts("pauses.keepBefore")}
							value={policy.keepBeforeSec}
							min={0}
							max={0.75}
							step={0.01}
							decimals={2}
							suffix=" s"
							onChange={(keepBeforeSec) => updatePolicy({ keepBeforeSec })}
							onCommit={() => undefined}
							flat
						/>
						<SliderCell
							label={ts("pauses.keepAfter")}
							value={policy.keepAfterSec}
							min={0}
							max={0.75}
							step={0.01}
							decimals={2}
							suffix=" s"
							onChange={(keepAfterSec) => updatePolicy({ keepAfterSec })}
							onCommit={() => undefined}
							flat
						/>
						<SliderCell
							label={ts("pauses.minimumKeptFragment")}
							value={policy.minimumKeptFragmentSec}
							min={0.1}
							max={2}
							step={0.05}
							decimals={2}
							suffix=" s"
							onChange={(minimumKeptFragmentSec) => updatePolicy({ minimumKeptFragmentSec })}
							onCommit={() => undefined}
							flat
						/>
						{policy.mode === "audio-level" ? (
							<>
								<label className={styles.inspectorSelectField}>
									<span>{ts("pauses.threshold")}</span>
									<select
										value={policy.manualThresholdDb === null ? "adaptive" : "manual"}
										onChange={(event) =>
											updatePolicy({
												manualThresholdDb: event.target.value === "manual" ? -38 : null,
											})
										}
									>
										<option value="adaptive">{ts("pauses.thresholdAdaptive")}</option>
										<option value="manual">{ts("pauses.thresholdManual")}</option>
									</select>
								</label>
								{policy.manualThresholdDb !== null ? (
									<SliderCell
										label={ts("pauses.thresholdDb")}
										value={policy.manualThresholdDb}
										min={-70}
										max={-10}
										step={1}
										suffix=" dB"
										onChange={(manualThresholdDb) => updatePolicy({ manualThresholdDb })}
										onCommit={() => undefined}
										flat
									/>
								) : null}
							</>
						) : null}
						<label className={styles.pauseToggleRow}>
							<span>{ts("pauses.protectScreen")}</span>
							<Toggle
								checked={policy.protectScreenActivity}
								onChange={(protectScreenActivity) => updatePolicy({ protectScreenActivity })}
							/>
						</label>
						<label className={styles.pauseToggleRow}>
							<span>{ts("pauses.protectSystemAudio")}</span>
							<Toggle
								checked={policy.protectSystemAudio}
								onChange={(protectSystemAudio) => updatePolicy({ protectSystemAudio })}
							/>
						</label>
						<div className={styles.pauseTransitionNote}>
							{ts("pauses.transition", { duration: policy.transitionMs })}
						</div>
					</div>
				) : null}

				<div className={styles.pauseResultHeader}>
					<div>
						<strong>
							{busy
								? ts("pauses.analyzing")
								: ts("pauses.resultCount", { count: suggestions.length })}
						</strong>
						<span>{ts("pauses.timeSaved", { duration: seconds(savedSec) })}</span>
					</div>
					{busy ? (
						<Loader2 className="animate-spin" size={15} />
					) : (
						<button
							type="button"
							onClick={() =>
								onSuggestionsChange(
									suggestions.map((suggestion) => ({ ...suggestion, selected: !allSelected })),
								)
							}
						>
							{allSelected ? ts("pauses.clearAll") : ts("pauses.selectAll")}
						</button>
					)}
				</div>

				{analysis?.missingTranscript && policy.mode === "speech" ? (
					<p className={styles.pauseNotice}>{ts("pauses.needsTranscript")}</p>
				) : null}
				{analysis?.missingSpeechActivity && policy.mode === "speech" ? (
					<p className={styles.pauseNotice}>{ts("pauses.speechModelUnavailable")}</p>
				) : null}
				{analysis?.missingMicrophone ? (
					<p className={styles.pauseNotice}>{ts("pauses.noMicrophone")}</p>
				) : null}
				{analysis?.usedMixedAudio ? (
					<p className={styles.pauseNotice}>{ts("pauses.usingMixedAudio")}</p>
				) : null}
				{status === "error" ? (
					<p className={styles.pauseNotice}>{ts("pauses.analysisFailed")}</p>
				) : null}

				{suggestions.length > 0 ? (
					<div className={styles.pauseSuggestionList}>
						{suggestions.map((suggestion) => (
							<button
								key={suggestion.id}
								type="button"
								className={suggestion.selected ? styles.pauseSuggestionSelected : undefined}
								onClick={() =>
									onSuggestionsChange(
										suggestions.map((candidate) =>
											candidate.id === suggestion.id
												? { ...candidate, selected: !candidate.selected }
												: candidate,
										),
									)
								}
							>
								<span className={styles.pauseSuggestionCheck}>
									{suggestion.selected ? <Check size={11} /> : null}
								</span>
								<span>{seconds(suggestion.silenceEndSec - suggestion.silenceStartSec)}</span>
								<small>−{seconds(suggestion.savedSec)}</small>
							</button>
						))}
					</div>
				) : null}

				<div className={styles.pauseActions}>
					<button type="button" onClick={togglePreview} disabled={selected.length === 0 || busy}>
						<Play size={14} fill={previewing ? "currentColor" : "none"} />
						{previewing ? ts("pauses.stopPreview") : ts("pauses.preview")}
					</button>
					<button
						type="button"
						className={styles.pauseApplyButton}
						onClick={() => void applySelected()}
						disabled={selected.length === 0 || busy}
					>
						<Scissors size={14} />
						{ts("pauses.applySelected", { count: selected.length })}
					</button>
				</div>

				<div className={styles.pausePresetSave}>
					<button type="button" onClick={() => setSaveOpen((open) => !open)}>
						<Save size={13} /> {ts("pauses.savePreset")}
					</button>
					{saveOpen ? (
						<form
							onSubmit={(event) => {
								event.preventDefault();
								setSavedPresets(savePausePreset(presetName, policy));
								setPresetName("");
								setSaveOpen(false);
							}}
						>
							<input
								value={presetName}
								onChange={(event) => setPresetName(event.target.value)}
								placeholder={ts("pauses.presetName")}
								autoFocus
							/>
							<button type="submit">{ts("pauses.save")}</button>
						</form>
					) : null}
					{savedPresets.length > 0 ? (
						<select
							aria-label={ts("pauses.savedPresets")}
							value=""
							onChange={(event) => {
								const preset = savedPresets.find(
									(candidate) => candidate.id === event.target.value,
								);
								if (preset) updatePolicy(preset.policy);
							}}
						>
							<option value="">{ts("pauses.savedPresets")}</option>
							{savedPresets.map((preset) => (
								<option key={preset.id} value={preset.id}>
									{preset.name}
								</option>
							))}
						</select>
					) : null}
				</div>
			</div>
		</Pane>
	);
}
