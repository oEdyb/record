import { assetMissing } from "./asset.missing";
import { brollOverCaption } from "./broll.over-caption";
import { cameraNested } from "./camera.nested";
import { cameraOverlap } from "./camera.overlap";
import { captionOrphaned } from "./caption.orphaned";
import type { ResolvedEdit, Span } from "./context";
import { cutLooseTail } from "./cut.loose-tail";
import { cutMidSentence, strongestCutFindings } from "./cut.mid-sentence";
import { gapSilence } from "./gap.silence";
import { layoutUnusedOverride } from "./layout.unused-override";
import { overlayOrphaned } from "./overlay.orphaned";
import { regionNearCut } from "./region.near-cut";
import { regionOffCut } from "./region.off-cut";
import { textOverBroll } from "./text.over-broll";
import { textOverCamera } from "./text.over-camera";
import type { CheckRule, RuleResult, Severity } from "./types";

export const checkRules: readonly CheckRule[] = [
	cameraNested,
	textOverCamera,
	textOverBroll,
	brollOverCaption,
	overlayOrphaned,
	cameraOverlap,
	regionNearCut,
	regionOffCut,
	captionOrphaned,
	gapSilence,
	cutMidSentence,
	cutLooseTail,
	assetMissing,
	layoutUnusedOverride,
];
export interface CheckRequest {
	range?: Span;
	rule?: string;
	deep?: boolean;
	page?: number;
	page_size?: number;
}
export function runChecks(context: ResolvedEdit, request: CheckRequest = {}, rules = checkRules) {
	if (request.rule && !checkRules.some((rule) => rule.id === request.rule))
		throw new Error(`Unknown check rule: ${request.rule}`);
	if (
		request.range &&
		(request.range.startSec < 0 ||
			request.range.endSec <= request.range.startSec ||
			request.range.endSec > context.durationSec)
	)
		throw new Error("Range must be inside the edited timeline.");
	const selected = rules.filter((rule) => !request.rule || rule.id === request.rule);
	const results = selected.map((rule) => rule.run(context));
	return summarizeChecks(results, selected, request);
}
export function summarizeChecks(
	results: RuleResult[],
	selected: readonly CheckRule[],
	request: CheckRequest = {},
) {
	const findings = strongestCutFindings(
		results
			.flatMap((result) => result.findings)
			.filter(
				(item) =>
					!request.range ||
					((item.span.startSec < request.range.endSec ||
						(item.span.startSec === request.range.endSec &&
							item.span.endSec === item.span.startSec)) &&
						item.span.endSec >= request.range.startSec),
			)
			.sort((a, b) => a.at - b.at || a.rule.localeCompare(b.rule)),
	);
	const counts: Record<Severity, number> & { byRule: Record<string, number> } = {
		error: 0,
		warning: 0,
		info: 0,
		byRule: Object.fromEntries(selected.map((rule) => [rule.id, 0])),
	};
	for (const item of findings) {
		counts[item.severity]++;
		counts.byRule[item.rule]++;
	}
	return {
		findings,
		counts,
		total: findings.length,
		notes: results.flatMap((result) => result.notes ?? []),
		rules: selected.map(({ id, severity, describe }) => ({ id, severity, describe })),
	};
}
export type CheckResult = ReturnType<typeof runChecks>;
