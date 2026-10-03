import type { z } from "zod";
import { readProjectDirectionObservations } from "@/components/ai-edition/regenerateAutomaticDirection";
import type { AxcutDocument } from "../schema";
import type { RecordedDirectionObservation } from "../timeline/automatic-direction";
import {
	type agentAutomaticSettingsSchema,
	resolveAgentAutomaticSettings,
} from "./automaticSettings";

type Report =
	| { status: "analyzing" }
	| { status: "ready"; recordings: RecordedDirectionObservation[] }
	| { status: "failed"; error: string };
const runs = new Map<string, { report: Report }>();
export function requestDirectionObservations(
	document: AxcutDocument,
	settings?: z.infer<typeof agentAutomaticSettingsSchema>,
): Report {
	const policy = resolveAgentAutomaticSettings(document, settings).policy;
	const key = JSON.stringify([document, policy]);
	const previous = runs.get(key);
	if (previous) {
		if (previous.report.status === "failed") runs.delete(key);
		return previous.report;
	}
	const run: { report: Report } = { report: { status: "analyzing" } };
	runs.set(key, run);
	while (runs.size > 2) {
		const oldest = runs.keys().next().value;
		if (oldest) runs.delete(oldest);
	}
	void readProjectDirectionObservations(document, policy).then(
		(recordings) => {
			run.report = { status: "ready", recordings };
		},
		(error) => {
			run.report = { status: "failed", error: String(error) };
		},
	);
	return run.report;
}
