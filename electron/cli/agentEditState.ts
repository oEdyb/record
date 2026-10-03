import { z } from "zod";
import { editedTimecode } from "../../src/lib/ai-edition/agent/editedTime";
import type { StateResult } from "../../src/lib/ai-edition/agent/effectiveState";
import { type CheckResult, checkRules } from "../../src/lib/ai-edition/checks";
import {
	REPLY_TIME_BASE_RULE,
	type TimeInput,
	timeInputObjectSchema,
	timeInputSchema,
} from "./agentTimeBase";

// state/check times are documented as edited; bare numbers stay edited and the
// e/r/s suffixes (or m:ss.s) name the clock explicitly. The broker converts.
const time = timeInputSchema("edited");
const range = z
	.tuple([time, time])
	.refine(([from, to]) => to.seconds > from.seconds, "Range end must exceed start");
const projectId = z.string().min(1).max(256);
export const stateCommandInput = z.strictObject({
	project_id: projectId,
	at: time,
	range: range.optional(),
});
const pageOptions = {
	page: z.number().int().min(1).max(1_000_000).default(1),
	page_size: z.number().int().min(1).max(50).default(50),
	deep: z.boolean().default(false),
};
export const checkCommandInput = z
	.strictObject({
		project_id: projectId.optional(),
		explain: z.string().min(1).max(100).optional(),
		...pageOptions,
		limit: z.number().int().min(1).max(50).default(30),
		all: z.boolean().default(false),
		range: range.optional(),
		rule: z.string().min(1).max(100).optional(),
	})
	.refine((input) => !(input.all && input.range), "Use --all or --range, not both")
	.refine(
		(input) => !!input.explain || !!input.project_id,
		"--project_id is required unless --explain is supplied",
	);
/** Bare number on the wire is edited seconds (compat); the object form carries the base. */
const wireTime = z.union([z.number().finite().nonnegative(), timeInputObjectSchema]);
const wireSeconds = (value: number | TimeInput) =>
	typeof value === "number" ? value : value.seconds;
const span = z
	.strictObject({
		startSec: wireTime,
		endSec: wireTime,
	})
	.refine((value) => wireSeconds(value.endSec) > wireSeconds(value.startSec));
export const stateBrokerInput = z
	.strictObject({
		projectId,
		at: wireTime.optional(),
		clipId: z.string().min(1).max(256).optional(),
		range: span.optional(),
	})
	.refine(
		(input) => (input.at === undefined) !== (input.clipId === undefined),
		"Provide exactly one state time or clip ID",
	);
export const checkBrokerInput = z.strictObject({
	...pageOptions,
	projectId,
	range: span.optional(),
	rule: z.string().min(1).max(100).optional(),
});

export function formatStateHuman(result: StateResult): string {
	const layout = (state: StateResult["state"]) => {
		const values = state.layout;
		const position = values.cameraPosition.value;
		return [
			`camera=${values.cameraMode.value}/${values.cameraPreset.value} [${values.cameraPreset.layer}]`,
			`anchor=${values.cameraAnchor.value ?? "none"} [${values.cameraAnchor.layer}]`,
			`position=${position ? `${position.cx.toFixed(3)},${position.cy.toFixed(3)}` : "none"} [${values.cameraPosition.layer}]`,
			`size=${values.cameraSize.value} (${values.cameraSize.percent}%) [${values.cameraSize.layer}]`,
			`shape=${values.cameraShape.value} [${values.cameraShape.layer}]`,
			`screen=${JSON.stringify(values.screenFraming.value)} [${values.screenFraming.layer}]`,
			`captions=${values.captions.value ? "on" : "off"} [${values.captions.layer}; scene base]`,
		].join(" ");
	};
	const regions = (state: StateResult["state"]) =>
		state.regions.map(
			(region) =>
				`${region.name} (${region.id}) ${region.remainingSec.toFixed(3)}s left [${region.origin}; ${region.layer}]`,
		);
	const audio = (state: StateResult["state"]) => {
		const route = state.audio.value;
		return `mic=${route.microphone.muted ? "muted" : route.microphone.volume} system=${route.system.muted ? "muted" : route.system.volume} source=${route.sourcePath ?? "none"} clean=${route.cleanMicrophonePath ?? "none"} overlays=${route.overlays.length} [project]`;
	};
	const state = result.state;
	return [
		`${editedTimecode(state.editedTimeSec)} ${state.clip.value?.name ?? "Empty edit"} (${state.clip.value?.id ?? "none"}) raw=${state.rawTimeSec.toFixed(3)} source=${state.sourceTimeSec?.toFixed(3) ?? "none"} cuts=-${state.cuts.previous?.distanceSec.toFixed(3) ?? "none"}/+${state.cuts.next?.distanceSec.toFixed(3) ?? "none"}`,
		`  ${layout(state)}`,
		...state.regions.map(
			(region, index) => `  ${regions(state)[index]} ${JSON.stringify(region.value)}`,
		),
		`  audio ${audio(state)}`,
		...result.spans.map(
			(span) =>
				`${editedTimecode(span.span.startSec)}–${editedTimecode(span.span.endSec)} ${span.clip.value?.name ?? "Empty"} (${span.clip.value?.id ?? "none"}) raw=${span.rawTimeSec.toFixed(3)} source=${span.sourceTimeSec?.toFixed(3) ?? "none"} ${layout(span)}; ${regions(span).join("; ") || "No active regions"}; audio ${audio(span)}`,
		),
	].join("\n");
}
export function explainCheck(ruleId: string) {
	if (ruleId === REPLY_TIME_BASE_RULE.id) return { ...REPLY_TIME_BASE_RULE };
	const rule = checkRules.find((rule) => rule.id === ruleId);
	if (!rule) throw new Error(`Unknown check rule: ${ruleId}`);
	return {
		id: rule.id,
		describe: rule.describe,
		severity: rule.severity,
		fix: rule.fix ?? "None; fix is null.",
	};
}
export function formatCheckHuman(result: CheckResult & { offset?: number }, limit = 30): string {
	const findings = (["error", "warning", "info"] as const)
		.flatMap((severity) => result.findings.filter((item) => item.severity === severity))
		.slice(0, limit);
	const more = Math.max(0, result.total - (result.offset ?? 0) - findings.length);
	const line = (value: string) => value.replace(/[\r\n\t]/g, " ").slice(0, 180);
	return [
		...Object.entries(result.counts.byRule).map(([rule, count]) => `${rule}: ${count}`),
		`${result.counts.error} errors, ${result.counts.warning} warnings, ${result.counts.info} info`,
		...findings.map(
			(item) => `${editedTimecode(item.at)} ${item.severity} ${item.rule}: ${line(item.message)}`,
		),
		...result.notes.slice(0, 3).map((note) => `Note: ${line(note)}`),
		...(result.notes.length > 3
			? [`${result.notes.length - 3} more evidence notes in --json`]
			: []),
		...(more > 0 ? [`${more} more, use --page`] : []),
	].join("\n");
}
