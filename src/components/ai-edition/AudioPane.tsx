import { AudioLines, Check, Info, Loader2, Play, Save, ScanSearch, Scissors } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppSelect } from "@/components/ui/app-select";
import {
	InspectorActionButton,
	InspectorDisclosure,
	InspectorSegmentedControl,
} from "@/components/ui/inspector";
import { Tooltip } from "@/components/ui/tooltip";
import { useScopedT } from "@/contexts/I18nContext";
import { useCleanVoiceRuntime } from "@/hooks/useCleanVoiceRuntime";
import { applyPauseSuggestions } from "@/lib/ai-edition/document/pause-edits";
import {
	type AudioDeliveryPreset,
	DEFAULT_AUDIO_PEAK_CEILING_DBTP,
	DEFAULT_AUDIO_TARGET_LUFS,
	MAX_AUDIO_PEAK_CEILING_DBTP,
	MAX_AUDIO_TARGET_LUFS,
	MIN_AUDIO_PEAK_CEILING_DBTP,
	MIN_AUDIO_TARGET_LUFS,
} from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import {
	type PauseAnalysisPolicy,
	type PausePresetId,
} from "@/lib/ai-edition/timeline/pause-analysis";
import styles from "./NewEditorShell.module.css";
import { type SelectablePauseSuggestion, usePauseAnalysisStore } from "./pauses/pauseAnalysisStore";
import {
	loadPausePolicy,
	loadSavedPausePresets,
	policyForBuiltInPausePreset,
	type SavedPausePreset,
	savePausePolicy,
	savePausePreset,
} from "./pauses/pausePreferences";
import { Pane, SliderCell, Toggle } from "./RightPanes";

export type { SelectablePauseSuggestion } from "./pauses/pauseAnalysisStore";

interface AudioPaneProps {
	onPreview: (suggestions: SelectablePauseSuggestion[] | null) => void;
}

const BUILT_IN_PRESETS: Array<{
	id: PausePresetId;
	key: "natural" | "balanced" | "tight";
}> = [
	{ id: "natural", key: "natural" },
	{ id: "balanced", key: "balanced" },
	{ id: "tight", key: "tight" },
];

function seconds(value: number): string {
	return `${value.toFixed(value < 1 ? 2 : 1)} s`;
}

function InfoTip({ label, content }: { label: string; content: string }) {
	return (
		<Tooltip
			content={content}
			side="left"
			className="max-w-56 whitespace-normal px-2.5 py-2 text-left leading-[1.4]"
		>
			<button
				type="button"
				className={styles.controlInfoButton}
				aria-label={`${label}: ${content}`}
			>
				<Info size={11} />
			</button>
		</Tooltip>
	);
}

export function AudioPane({ onPreview }: AudioPaneProps) {
	const ts = useScopedT("settings");
	const {
		settings,
		hasDocument,
		set: setEditorSettings,
		setLive: setEditorSettingsLive,
		commit: commitEditorSettings,
	} = useEditorSettings();
	const document = useProjectStore((state) => state.document);
	const projectId = useProjectStore((state) => state.projectId);
	const projectRevision = useProjectStore((state) => state.revision);
	const applyDocumentPatch = useProjectStore((state) => state.applyDocumentPatch);
	const analysisProjectId = usePauseAnalysisStore((state) => state.projectId);
	const analysisStatus = usePauseAnalysisStore((state) => state.status);
	const analysis = usePauseAnalysisStore((state) => state.analysis);
	const storedSuggestions = usePauseAnalysisStore((state) => state.suggestions);
	const runPauseAnalysis = usePauseAnalysisStore((state) => state.analyze);
	const setPauseSuggestions = usePauseAnalysisStore((state) => state.setSuggestions);
	const invalidatePauseAnalysis = usePauseAnalysisStore((state) => state.invalidate);
	const suggestions = analysisProjectId === projectId ? storedSuggestions : [];
	const { snapshot: cleanVoiceRuntime } = useCleanVoiceRuntime(document);
	const [policy, setPolicy] = useState<PauseAnalysisPolicy>(loadPausePolicy);
	const [applyStatus, setApplyStatus] = useState<"idle" | "applying" | "error">("idle");
	const [previewing, setPreviewing] = useState(false);
	const [savedPresets, setSavedPresets] = useState<SavedPausePreset[]>(loadSavedPausePresets);
	const [presetName, setPresetName] = useState("");
	const [saveOpen, setSaveOpen] = useState(false);
	const cleanVoiceAssets = document?.assets.filter((asset) => Boolean(asset.originalPath)) ?? [];
	const cleanVoiceEnabled =
		cleanVoiceAssets.length > 0 &&
		cleanVoiceAssets.every((asset) => asset.cleanVoice?.mode === "natural");
	const cleanVoiceStatuses = cleanVoiceRuntime.assets.filter((status) =>
		cleanVoiceAssets.some((asset) => asset.id === status.assetId),
	);
	const cleanVoiceStatus = !cleanVoiceEnabled
		? null
		: cleanVoiceStatuses.some((item) => item.phase === "failed")
			? "failed"
			: cleanVoiceStatuses.length === cleanVoiceAssets.length &&
					cleanVoiceStatuses.every((item) => item.phase === "ready")
				? "ready"
				: "processing";

	const setCleanVoice = useCallback(
		async (enabled: boolean) => {
			if (!projectId || cleanVoiceAssets.length === 0) return;
			const result = await applyDocumentPatch(
				projectId,
				(current) => ({
					...current,
					assets: current.assets.map((asset) => ({
						...asset,
						cleanVoice: enabled
							? {
									version: 1 as const,
									mode: "natural" as const,
									engine: "deepfilternet3" as const,
									attenuationLimitDb: 6,
									postFilter: false,
								}
							: { version: 1 as const, mode: "original" as const },
					})),
				}),
				{ createHistorySnapshot: (current) => current },
			);
			if (result === "conflict" || result === "project-changed") {
				toast.error(ts("audio.cleanVoiceSaveFailed"));
			}
		},
		[applyDocumentPatch, cleanVoiceAssets.length, projectId, ts],
	);

	const updatePolicy = useCallback(
		(patch: Partial<PauseAnalysisPolicy>) => {
			invalidatePauseAnalysis();
			setPreviewing(false);
			onPreview(null);
			setPolicy((current) => {
				const next = { ...current, ...patch };
				savePausePolicy(next);
				return next;
			});
		},
		[invalidatePauseAnalysis, onPreview],
	);

	const analyzePauses = useCallback(() => {
		if (!document || !projectId || analysisStatus === "analyzing") return;
		setPreviewing(false);
		onPreview(null);
		void runPauseAnalysis(document, projectRevision, policy);
	}, [analysisStatus, document, onPreview, policy, projectId, projectRevision, runPauseAnalysis]);

	useEffect(
		() => () => {
			onPreview(null);
		},
		[onPreview],
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
		setApplyStatus("applying");
		onPreview(null);
		setPreviewing(false);
		const result = await applyDocumentPatch(
			projectId,
			(current) => applyPauseSuggestions(current, selected),
			{ createHistorySnapshot: (current) => current },
		);
		if (result === "applied") {
			toast.success(ts("pauses.applied", { count: selected.length }));
			invalidatePauseAnalysis();
			setApplyStatus("idle");
			return;
		}
		if (result === "unchanged") {
			toast.info(ts("pauses.nothingToApply"));
			invalidatePauseAnalysis();
			setApplyStatus("idle");
			return;
		}
		toast.error(ts("pauses.applyFailed"));
		setApplyStatus("error");
	}, [applyDocumentPatch, invalidatePauseAnalysis, onPreview, projectId, selected, ts]);

	const togglePreview = () => {
		const next = !previewing;
		setPreviewing(next);
		onPreview(next ? selected : null);
	};

	const busy = analysisStatus === "analyzing" || applyStatus === "applying";
	const allSelected = suggestions.length > 0 && selected.length === suggestions.length;
	const setDeliveryPreset = (audioDeliveryPreset: AudioDeliveryPreset) => {
		void setEditorSettings(
			audioDeliveryPreset === "youtube"
				? {
						audioDeliveryPreset,
						audioTargetLufs: DEFAULT_AUDIO_TARGET_LUFS,
						audioPeakCeilingDbtp: DEFAULT_AUDIO_PEAK_CEILING_DBTP,
					}
				: { audioDeliveryPreset },
		);
	};
	const activePausePreset =
		BUILT_IN_PRESETS.find((preset) => {
			const candidate = policyForBuiltInPausePreset(preset.id, policy);
			return (
				Math.abs(policy.minimumPauseSec - candidate.minimumPauseSec) < 0.001 &&
				Math.abs(policy.shortenedPauseSec - candidate.shortenedPauseSec) < 0.001
			);
		})?.id ?? "";

	return (
		<Pane
			title={ts("audio.title")}
			icon={<AudioLines size={16} />}
			helpText={ts("audio.help")}
			flat
		>
			<div className={styles.audioInspector}>
				<section className={styles.audioSection}>
					<div className={styles.audioSectionHeader}>
						<strong>
							{ts("audio.voice")}
							<InfoTip label={ts("audio.voice")} content={ts("audio.voiceDescription")} />
						</strong>
					</div>
					<div className={styles.audioSettingRow}>
						<span className={styles.audioSettingTitle}>
							{ts("audio.cleanVoice")}
							{cleanVoiceStatus ? <small>{ts(`audio.cleanVoice${cleanVoiceStatus}`)}</small> : null}
							<InfoTip
								label={ts("audio.cleanVoice")}
								content={`${ts("audio.cleanVoiceDescription")} ${ts("audio.cleanVoiceTrust")}`}
							/>
						</span>
						<Toggle
							checked={cleanVoiceEnabled}
							disabled={
								!hasDocument ||
								cleanVoiceAssets.length === 0 ||
								(!cleanVoiceRuntime.available && !cleanVoiceEnabled)
							}
							label={ts("audio.cleanVoice")}
							onChange={(enabled) => void setCleanVoice(enabled)}
						/>
					</div>
					<div className={styles.audioSettingRow}>
						<span className={styles.audioSettingTitle}>
							{ts("audio.evenVolume")}
							<InfoTip label={ts("audio.evenVolume")} content={ts("audio.evenVolumeDescription")} />
						</span>
						<Toggle
							checked={settings.evenVolume}
							disabled={!hasDocument}
							label={ts("audio.evenVolume")}
							onChange={(evenVolume) => void setEditorSettings({ evenVolume })}
						/>
					</div>
				</section>

				<section className={styles.audioSection}>
					<div className={styles.audioSectionHeader}>
						<strong>
							{ts("audio.pacing")}
							<InfoTip label={ts("audio.pacing")} content={ts("audio.pacingDescription")} />
						</strong>
					</div>
					<div className={styles.pauseInspector}>
						<label className={styles.inspectorSelectField}>
							<span>{ts("pauses.mode")}</span>
							<AppSelect
								value={policy.mode}
								onChange={(event) =>
									updatePolicy({
										mode: event.target.value as PauseAnalysisPolicy["mode"],
									})
								}
							>
								<option value="speech">{ts("pauses.modeSpeech")}</option>
								<option value="audio-level">{ts("pauses.modeAudioLevel")}</option>
							</AppSelect>
						</label>

						<InspectorSegmentedControl
							label={ts("audio.preset")}
							value={activePausePreset}
							options={BUILT_IN_PRESETS.map((preset) => ({
								value: preset.id,
								label: ts(`pauses.${preset.key}`),
							}))}
							onValueChange={(presetId) => {
								if (presetId) updatePolicy(policyForBuiltInPausePreset(presetId, policy));
							}}
						/>

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

						<InspectorDisclosure label={ts("pauses.advanced")}>
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
											<AppSelect
												value={policy.manualThresholdDb === null ? "adaptive" : "manual"}
												onChange={(event) =>
													updatePolicy({
														manualThresholdDb: event.target.value === "manual" ? -38 : null,
													})
												}
											>
												<option value="adaptive">{ts("pauses.thresholdAdaptive")}</option>
												<option value="manual">{ts("pauses.thresholdManual")}</option>
											</AppSelect>
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
								{policy.mode === "speech" ? (
									<label className={styles.pauseToggleRow}>
										<span>{ts("pauses.includeNonSpeechEvents")}</span>
										<Toggle
											checked={policy.includeNonSpeechEvents}
											label={ts("pauses.includeNonSpeechEvents")}
											onChange={(includeNonSpeechEvents) =>
												updatePolicy({ includeNonSpeechEvents })
											}
										/>
									</label>
								) : null}
								<label className={styles.pauseToggleRow}>
									<span>{ts("pauses.protectScreen")}</span>
									<Toggle
										checked={policy.protectScreenActivity}
										label={ts("pauses.protectScreen")}
										onChange={(protectScreenActivity) => updatePolicy({ protectScreenActivity })}
									/>
								</label>
								<label className={styles.pauseToggleRow}>
									<span>{ts("pauses.protectSystemAudio")}</span>
									<Toggle
										checked={policy.protectSystemAudio}
										label={ts("pauses.protectSystemAudio")}
										onChange={(protectSystemAudio) => updatePolicy({ protectSystemAudio })}
									/>
								</label>
							</div>
						</InspectorDisclosure>

						<InspectorActionButton
							className={styles.pauseScanButton}
							tone={analysisStatus === "ready" ? "secondary" : "primary"}
							disabled={!document || analysisStatus === "analyzing" || applyStatus === "applying"}
							onClick={analyzePauses}
						>
							{analysisStatus === "analyzing" ? (
								<Loader2 className="animate-spin" size={14} aria-hidden />
							) : (
								<ScanSearch size={14} aria-hidden />
							)}
							{analysisStatus === "analyzing"
								? ts("pauses.analyzing")
								: analysisStatus === "ready"
									? ts("pauses.analyzeAgain")
									: ts("pauses.analyze")}
						</InspectorActionButton>

						{analysisStatus === "ready" ? (
							<div className={styles.pauseResultHeader}>
								<div>
									<strong>{ts("pauses.resultCount", { count: suggestions.length })}</strong>
									<span>{ts("pauses.timeSaved", { duration: seconds(savedSec) })}</span>
								</div>
								{suggestions.length > 0 ? (
									<button
										type="button"
										onClick={() =>
											setPauseSuggestions(
												suggestions.map((suggestion) => ({
													...suggestion,
													selected: !allSelected,
												})),
											)
										}
									>
										{allSelected ? ts("pauses.clearAll") : ts("pauses.selectAll")}
									</button>
								) : null}
							</div>
						) : null}

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
						{analysisStatus === "error" || applyStatus === "error" ? (
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
											setPauseSuggestions(
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

						{analysisStatus === "ready" && suggestions.length > 0 ? (
							<div className={styles.pauseActions}>
								<button
									type="button"
									onClick={togglePreview}
									disabled={selected.length === 0 || busy}
								>
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
						) : null}

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
								<AppSelect
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
								</AppSelect>
							) : null}
						</div>
					</div>
				</section>

				<section className={styles.audioSection}>
					<div className={styles.audioSectionHeader}>
						<strong>
							{ts("audio.delivery")}
							<InfoTip label={ts("audio.delivery")} content={ts("audio.deliveryDescription")} />
						</strong>
					</div>
					<div className={styles.audioSettingRow}>
						<span className={styles.audioSettingTitle}>
							{ts("audio.normalizeVolume")}
							<InfoTip
								label={ts("audio.normalizeVolume")}
								content={ts("audio.normalizeVolumeDescription")}
							/>
						</span>
						<Toggle
							checked={settings.normalizeVolume}
							disabled={!hasDocument}
							label={ts("audio.normalizeVolume")}
							onChange={(normalizeVolume) => void setEditorSettings({ normalizeVolume })}
						/>
					</div>
					<div className={styles.inspectorSelectField}>
						<span className={styles.audioSettingTitle}>
							{ts("audio.preset")}
							<InfoTip label={ts("audio.preset")} content={ts("audio.youtubeNote")} />
						</span>
						<AppSelect
							aria-label={ts("audio.preset")}
							value={settings.audioDeliveryPreset}
							disabled={!hasDocument || !settings.normalizeVolume}
							onChange={(event) => setDeliveryPreset(event.target.value as AudioDeliveryPreset)}
						>
							<option value="youtube">{ts("audio.youtubeTarget")}</option>
							<option value="custom">{ts("audio.custom")}</option>
						</AppSelect>
					</div>
					{settings.audioDeliveryPreset === "custom" ? (
						<div className={styles.audioDeliveryControls}>
							<SliderCell
								label={ts("audio.targetLoudness")}
								helpText={ts("audio.targetLoudnessHelp")}
								value={settings.audioTargetLufs}
								min={MIN_AUDIO_TARGET_LUFS}
								max={MAX_AUDIO_TARGET_LUFS}
								step={0.5}
								decimals={1}
								suffix=" LUFS"
								disabled={!hasDocument || !settings.normalizeVolume}
								onChange={(audioTargetLufs) => setEditorSettingsLive({ audioTargetLufs })}
								onCommit={() => void commitEditorSettings()}
								flat
							/>
							<SliderCell
								label={ts("audio.peakCeiling")}
								helpText={ts("audio.peakCeilingHelp")}
								value={settings.audioPeakCeilingDbtp}
								min={MIN_AUDIO_PEAK_CEILING_DBTP}
								max={MAX_AUDIO_PEAK_CEILING_DBTP}
								step={0.5}
								decimals={1}
								suffix=" dBTP"
								disabled={!hasDocument || !settings.normalizeVolume}
								onChange={(audioPeakCeilingDbtp) => setEditorSettingsLive({ audioPeakCeilingDbtp })}
								onCommit={() => void commitEditorSettings()}
								flat
							/>
						</div>
					) : (
						<div className={styles.audioTargetSummary} aria-label={ts("audio.youtubeNote")}>
							<span>{DEFAULT_AUDIO_TARGET_LUFS.toFixed(1)} LUFS</span>
							<span>{DEFAULT_AUDIO_PEAK_CEILING_DBTP.toFixed(0)} dBTP</span>
						</div>
					)}
				</section>
			</div>
		</Pane>
	);
}
