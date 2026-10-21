import { asObjects, asStrings, type DropMap } from "./decide";
import { parseJsonObject } from "./modelJson";
import { SESSION_PROMPT } from "./prompts";
import { dateClockTime, fixed } from "./pyCompat";
import type { DecisionModel } from "./types";
import type { Unit } from "./units";

export interface SessionDrop {
	ids: string[];
	kind?: string;
	reason?: string;
}

function line(unit: Unit): string {
	return `[${unit.id} ${fixed(unit.start, 1)}-${fixed(unit.end, 1)}s gap ${fixed(unit.gapBefore, 1)}s] ${unit.text}`;
}

export function sessionPrompt(units: Unit[]): string {
	const order = new Map<string, number>();
	units.forEach((u, i) => {
		order.set(u.take.id, i);
	});
	const sorted = units
		.map((u, index) => ({ u, index }))
		.sort(
			(a, b) =>
				a.u.take.recordedAtMs - b.u.take.recordedAtMs ||
				(order.get(a.u.take.id) as number) - (order.get(b.u.take.id) as number) ||
				a.index - b.index,
		);
	const lines: string[] = [];
	for (const { u } of sorted) {
		if (u.id.endsWith(".U01")) {
			lines.push(
				`== ${u.id.slice(0, 3)} (${u.take.key}) recorded ${dateClockTime(u.take.recordedAtMs)} ==`,
			);
		}
		lines.push(line(u));
	}
	return SESSION_PROMPT + lines.join("\n");
}

/** The whole-session pass: the units the model would drop. */
export async function sessionDrops(units: Unit[], model: DecisionModel): Promise<SessionDrop[]> {
	const reply = parseJsonObject(await model.ask(sessionPrompt(units), "session"));
	if (!Array.isArray(reply.drop)) throw new Error("Session reply has no drop list.");
	const known = new Set(units.map((u) => u.id));
	return asObjects(reply.drop)
		.map((d) => ({
			ids: asStrings(d.ids).filter((id) => known.has(id)),
			kind: typeof d.kind === "string" ? d.kind : undefined,
			reason: typeof d.reason === "string" ? d.reason : undefined,
		}))
		.filter((d) => d.ids.length > 0);
}

/** Unions the session pass into drop. Returns how many words only this pass cut. */
export function mergeSession(
	wordOf: (unit: Unit) => number[],
	units: Unit[],
	drops: SessionDrop[],
	drop: DropMap,
): number {
	const byId = new Map(units.map((u) => [u.id, u]));
	let added = 0;
	for (const d of drops) {
		for (const uid of d.ids) {
			for (const i of wordOf(byId.get(uid) as Unit)) {
				const old = drop.get(i);
				if (old) {
					drop.set(i, { ...old, sources: [...new Set([...old.sources, "session" as const])] });
				} else {
					drop.set(i, {
						kind: d.kind ?? "unit",
						reason: d.reason ?? "",
						sources: ["session"],
						keep: [],
					});
					added += 1;
				}
			}
		}
	}
	return added;
}
