import { describe, expect, it, vi } from "vitest";
import { ClipJournalLifecycle } from "./clipJournalLifecycle";

describe("clip journal lifecycle", () => {
	it("rejects a second edit until reconciliation acknowledges the original owner", () => {
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const journal = new ClipJournalLifecycle();
		const clip = { index: 0, screenVideoPath: "/private/clip.mp4", durationMs: 500 };
		journal.transition({ type: "clips", clips: [clip] });
		const token = Symbol("remove");
		expect(
			journal.transition({ type: "begin", change: { token, clips: [{ ...clip, removed: true }] } }),
		).toBe(true);
		expect(journal.clips).toEqual([clip]);
		journal.transition({ type: "failed", token });
		expect(journal.editsPaused).toBe(true);
		expect(journal.transition({ type: "begin", change: { token: Symbol(), clips: [] } })).toBe(
			false,
		);
		expect(journal.transition({ type: "committed", token })).toBe(false);
		journal.transition({ type: "reconcile" });
		expect(journal.transition({ type: "reconciled", token: Symbol() })).toBe(false);
		expect(journal.transition({ type: "reconciled", token })).toBe(true);
		expect(journal.clips).toEqual([clip]);
		expect(log).toHaveBeenCalledTimes(3);
		log.mockRestore();
	});
});
