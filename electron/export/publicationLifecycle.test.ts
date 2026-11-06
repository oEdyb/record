import { describe, expect, it, vi } from "vitest";
import { PublicationLifecycle } from "./publicationLifecycle";

describe("export publication lifecycle", () => {
	it("rejects and logs publication before verification without advancing", () => {
		const lifecycle = new PublicationLifecycle<number>();
		const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			expect(lifecycle.transition({ type: "phase", phase: "publishing" })).toBe(false);
			expect(lifecycle.getSnapshot()).toEqual({ kind: "preflight" });
			expect(log).toHaveBeenCalledWith("[export-publication] Illegal transition", {
				state: "preflight",
				event: "phase",
				phase: "publishing",
			});
		} finally {
			log.mockRestore();
		}
	});
	it("refuses to clean up a committed export", () => {
		const lifecycle = new PublicationLifecycle<string>();
		const timer = setInterval(() => undefined, 1000);
		try {
			lifecycle.transition({ type: "render", timer });
			lifecycle.transition({ type: "rendered" });
			lifecycle.transition({ type: "phase", phase: "verification" });
			lifecycle.transition({ type: "phase", phase: "syncing" });
			lifecycle.transition({ type: "phase", phase: "publishing" });
			lifecycle.transition({ type: "committed", result: "saved" });
			expect(lifecycle.transition({ type: "phase", phase: "cleanup" })).toBe(false);
			expect(lifecycle.committed).toEqual({ result: "saved" });
		} finally {
			clearInterval(timer);
		}
	});
});
