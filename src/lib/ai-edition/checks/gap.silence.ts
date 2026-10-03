import { type CheckRule, finding } from "./types";

export const gapSilence: CheckRule = {
	id: "gap.silence",
	severity: "warning",
	audio: true,
	describe: "Microphone dead air longer than 1 second remains in kept footage.",
	run(context) {
		const missing = new Set<string>();
		const findings = context.fragments.flatMap((fragment) => {
			const audio = context.audio.get(fragment.assetId);
			if (!audio?.microphonePeaks?.length) {
				missing.add(fragment.assetId);
				return [];
			}
			return audio.quietSpans.flatMap((quiet) => {
				const start = Math.max(fragment.source.startSec, quiet.startSec);
				const end = Math.min(fragment.source.endSec, quiet.endSec);
				if (end - start <= 1) return [];
				const startSec = fragment.edited.startSec + start - fragment.source.startSec;
				return [
					finding(
						gapSilence,
						{ startSec, endSec: startSec + end - start },
						fragment.clip,
						`Microphone silence lasts ${(end - start).toFixed(3)}s.`,
					),
				];
			});
		});
		return {
			findings,
			notes: [...missing].map(
				(id) => `gap.silence skipped: microphone peaks unavailable for ${id}.`,
			),
		};
	},
};
