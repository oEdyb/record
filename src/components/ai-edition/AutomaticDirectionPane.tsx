import { RotateCcw, Save, Sparkles, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AppSelect } from "@/components/ui/app-select";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { DEFAULT_AUTOMATIC_DIRECTION_POLICY } from "@/lib/ai-edition/timeline/automatic-direction";
import {
	type AutomaticDirectionNumberControl,
	type AutomaticDirectionPreset,
	automaticDirectionNumberControls,
	automaticDirectionPolicyValue,
	DEFAULT_AUTOMATIC_DIRECTION_PRESET_ID,
	deleteAutomaticDirectionPreset,
	loadAutomaticDirectionPresets,
	policyForAutomaticDirectionPreset,
	readAutomaticDirectionSettings,
	saveAutomaticDirectionPreset,
	setAutomaticDirectionPolicyValue,
} from "@/lib/ai-edition/timeline/automatic-direction-settings";
import styles from "./NewEditorShell.module.css";
import { Pane, SliderCell } from "./RightPanes";
import {
	canRegenerateAutomaticDirection,
	regenerateProjectAutomaticDirection,
} from "./regenerateAutomaticDirection";

const LIVE_REPLAN_DEBOUNCE_MS = 180;

type Policy = typeof DEFAULT_AUTOMATIC_DIRECTION_POLICY;
type PendingUpdate = { policy: Policy; presetId: string | null };

function displayedControl(control: AutomaticDirectionNumberControl) {
	return control.suffix === " ms"
		? {
				min: control.min / 1_000,
				max: control.max / 1_000,
				step: control.step / 1_000,
				decimals: 2,
				suffix: " s",
				toDisplay: (value: number) => value / 1_000,
				fromDisplay: (value: number) => value * 1_000,
			}
		: {
				min: control.min,
				max: control.max,
				step: control.step,
				decimals: control.decimals,
				suffix: control.suffix,
				toDisplay: (value: number) => value,
				fromDisplay: (value: number) => value,
			};
}

function PolicySlider({
	control,
	policy,
	disabled,
	onChange,
	onCommit,
}: {
	control: AutomaticDirectionNumberControl;
	policy: Policy;
	disabled: boolean;
	onChange: (path: string, value: number) => void;
	onCommit: () => void;
}) {
	const display = displayedControl(control);
	return (
		<div title={control.description}>
			<SliderCell
				label={control.label}
				value={display.toDisplay(automaticDirectionPolicyValue(policy, control.path))}
				min={display.min}
				max={display.max}
				step={display.step}
				decimals={display.decimals}
				suffix={display.suffix}
				disabled={disabled}
				onChange={(value) => onChange(control.path, display.fromDisplay(value))}
				onCommit={onCommit}
				flat
			/>
		</div>
	);
}

function policiesMatch(left: Policy, right: Policy): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

export function AutomaticDirectionPane() {
	const document = useProjectStore((state) => state.document);
	const projectId = useProjectStore((state) => state.projectId);
	const revision = useProjectStore((state) => state.revision);
	const stored = useMemo(
		() => (document ? readAutomaticDirectionSettings(document) : null),
		[document],
	);
	const [policy, setPolicy] = useState<Policy>(
		() => stored?.policy ?? DEFAULT_AUTOMATIC_DIRECTION_POLICY,
	);
	const [presetId, setPresetId] = useState<string | null>(
		() => stored?.presetId ?? DEFAULT_AUTOMATIC_DIRECTION_PRESET_ID,
	);
	const [presets, setPresets] = useState<AutomaticDirectionPreset[]>(() =>
		loadAutomaticDirectionPresets(),
	);
	const [status, setStatus] = useState<"idle" | "updating" | "error">("idle");
	const [saveOpen, setSaveOpen] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [presetName, setPresetName] = useState("");
	const policyRef = useRef(policy);
	const presetIdRef = useRef(presetId);
	const debounceRef = useRef<number | null>(null);
	const runningRef = useRef(false);
	const pendingRef = useRef<PendingUpdate | null>(null);
	const mountedRef = useRef(true);
	const sessionRef = useRef<{
		projectId: string;
		lastAppliedRevision: number;
	} | null>(null);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
		};
	}, []);

	useEffect(() => {
		if (!stored || !projectId) return;
		const ownRevision = sessionRef.current?.lastAppliedRevision;
		if (runningRef.current || pendingRef.current || revision === ownRevision) return;
		policyRef.current = stored.policy;
		presetIdRef.current = stored.presetId;
		setPolicy(stored.policy);
		setPresetId(stored.presetId);
		sessionRef.current = null;
	}, [projectId, revision, stored]);

	const executePending = useCallback(async () => {
		if (runningRef.current || !projectId) return;
		runningRef.current = true;
		try {
			while (pendingRef.current) {
				const request = pendingRef.current;
				pendingRef.current = null;
				if (mountedRef.current) setStatus("updating");
				const currentRevision = useProjectStore.getState().revision;
				const currentSession = sessionRef.current;
				const continuesSession =
					currentSession?.projectId === projectId &&
					currentSession.lastAppliedRevision === currentRevision;
				await regenerateProjectAutomaticDirection(projectId, {
					policy: request.policy,
					presetId: request.presetId,
					createHistorySnapshot: !continuesSession,
				});
				sessionRef.current = {
					projectId,
					lastAppliedRevision: useProjectStore.getState().revision,
				};
			}
			if (mountedRef.current) setStatus("idle");
		} catch (error) {
			pendingRef.current = null;
			if (mountedRef.current) setStatus("error");
			toast.error("Could not update automatic edits", {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			runningRef.current = false;
			if (pendingRef.current) void executePending();
		}
	}, [projectId]);

	const queueUpdate = useCallback(
		(nextPolicy: Policy, nextPresetId: string | null, immediate = false) => {
			policyRef.current = nextPolicy;
			presetIdRef.current = nextPresetId;
			setPolicy(nextPolicy);
			setPresetId(nextPresetId);
			pendingRef.current = { policy: nextPolicy, presetId: nextPresetId };
			if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
			if (immediate) {
				debounceRef.current = null;
				void executePending();
				return;
			}
			debounceRef.current = window.setTimeout(() => {
				debounceRef.current = null;
				void executePending();
			}, LIVE_REPLAN_DEBOUNCE_MS);
		},
		[executePending],
	);

	const setValue = useCallback(
		(path: string, value: number) => {
			queueUpdate(setAutomaticDirectionPolicyValue(policyRef.current, path, value), null);
		},
		[queueUpdate],
	);

	const commitPending = useCallback(() => {
		if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
		debounceRef.current = null;
		if (pendingRef.current) void executePending();
	}, [executePending]);

	const controls = useMemo(() => automaticDirectionNumberControls(policy), [policy]);
	const primaryControls = controls.filter((control) => control.primary);
	const advancedGroups = useMemo(() => {
		const groups = new Map<string, typeof controls>();
		for (const control of controls) {
			if (control.primary) continue;
			groups.set(control.group, [...(groups.get(control.group) ?? []), control]);
		}
		return [...groups.entries()];
	}, [controls]);
	const canRegenerate = canRegenerateAutomaticDirection(document);

	const applyPreset = (id: string) => {
		if (id === DEFAULT_AUTOMATIC_DIRECTION_PRESET_ID) {
			queueUpdate(DEFAULT_AUTOMATIC_DIRECTION_POLICY, id, true);
			return;
		}
		const preset = presets.find((candidate) => candidate.id === id);
		if (preset) queueUpdate(policyForAutomaticDirectionPreset(preset), preset.id, true);
	};

	const savePreset = () => {
		const saved = saveAutomaticDirectionPreset(presetName, policyRef.current);
		if (!saved) {
			toast.error("Enter a preset name");
			return;
		}
		setPresets(loadAutomaticDirectionPresets());
		setPresetName("");
		setSaveOpen(false);
		queueUpdate(policyRef.current, saved.id, true);
		toast.success("Preset saved");
	};

	const removePreset = () => {
		if (!presetId?.startsWith("custom-")) return;
		if (!deleteAutomaticDirectionPreset(presetId)) {
			toast.error("Could not remove preset");
			return;
		}
		setPresets(loadAutomaticDirectionPresets());
		queueUpdate(policyRef.current, null, true);
	};

	return (
		<Pane
			title="Automatic"
			icon={<Sparkles size={14} />}
			helpText="Tune the deterministic first edit. Every result remains editable on the timeline."
			flat
		>
			<section className={styles.inspectorSection}>
				<div className={styles.automaticPresetHead}>
					<AppSelect
						aria-label="Automatic editing preset"
						value={presetId ?? "custom"}
						disabled={!canRegenerate || status === "updating"}
						onChange={(event) => applyPreset(event.target.value)}
					>
						<option value={DEFAULT_AUTOMATIC_DIRECTION_PRESET_ID}>Balanced</option>
						{presets.map((preset) => (
							<option key={preset.id} value={preset.id}>
								{preset.name}
							</option>
						))}
						{presetId === null ? <option value="custom">Custom</option> : null}
					</AppSelect>
					<button type="button" onClick={() => setSaveOpen((open) => !open)} title="Save preset">
						<Save size={14} />
					</button>
					{presetId?.startsWith("custom-") ? (
						<button type="button" onClick={removePreset} title="Remove preset">
							<Trash2 size={14} />
						</button>
					) : null}
				</div>
				{saveOpen ? (
					<form
						className={styles.automaticPresetSave}
						onSubmit={(event) => {
							event.preventDefault();
							savePreset();
						}}
					>
						<input
							autoFocus
							value={presetName}
							maxLength={64}
							placeholder="Preset name"
							onChange={(event) => setPresetName(event.target.value)}
						/>
						<button type="submit">Save</button>
					</form>
				) : null}
				<div className={styles.automaticStatus} data-state={status} role="status">
					<span>
						{status === "updating"
							? "Updating preview…"
							: status === "error"
								? "Update failed"
								: "Live preview"}
					</span>
					<button
						type="button"
						disabled={
							!canRegenerate ||
							status === "updating" ||
							policiesMatch(policy, DEFAULT_AUTOMATIC_DIRECTION_POLICY)
						}
						onClick={() =>
							queueUpdate(
								DEFAULT_AUTOMATIC_DIRECTION_POLICY,
								DEFAULT_AUTOMATIC_DIRECTION_PRESET_ID,
								true,
							)
						}
					>
						<RotateCcw size={12} /> Reset
					</button>
				</div>
			</section>

			{primaryControls.map((control) => (
				<PolicySlider
					key={control.path}
					control={control}
					policy={policy}
					disabled={!canRegenerate}
					onChange={setValue}
					onCommit={commitPending}
				/>
			))}

			<details
				className={styles.automaticAdvanced}
				onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
			>
				<summary>
					<span>All parameters</span>
					<span>{controls.length}</span>
				</summary>
				<p>Max Zoom scales the automatic depth profile. Balanced stays at 1.65×.</p>
				{advancedOpen
					? advancedGroups.map(([group, groupControls]) => (
							<section key={group} className={styles.automaticAdvancedGroup}>
								<h3>{group}</h3>
								{groupControls.map((control) => (
									<PolicySlider
										key={control.path}
										control={control}
										policy={policy}
										disabled={!canRegenerate}
										onChange={setValue}
										onCommit={commitPending}
									/>
								))}
							</section>
						))
					: null}
			</details>
		</Pane>
	);
}
