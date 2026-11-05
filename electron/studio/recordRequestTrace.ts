export interface RecordTraceEntry {
	token: number;
	atMs: number;
	stage: string;
	flags: Record<string, boolean | number | null>;
}

export class RecordRequestTrace {
	private sequence = 0;
	private entries: RecordTraceEntry[] = [];
	begin(flags: RecordTraceEntry["flags"]): number {
		this.sequence = (this.sequence % Number.MAX_SAFE_INTEGER) + 1;
		this.add(this.sequence, "dispatch", flags);
		return this.sequence;
	}
	add(token: number, stage: string, flags: RecordTraceEntry["flags"] = {}) {
		if (!Number.isSafeInteger(token) || token <= 0) return;
		this.entries.push({ token, atMs: Date.now(), stage: stage.slice(0, 64), flags: { ...flags } });
		if (this.entries.length > 256) this.entries.shift();
	}
	currentToken() {
		return this.sequence;
	}
	read() {
		return this.entries.map((entry) => ({ ...entry, flags: { ...entry.flags } }));
	}
}

export const recordRequestTrace = new RecordRequestTrace();
