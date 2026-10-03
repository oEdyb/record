import { describe, expect, it, vi } from "vitest";
import { createEmptyDocument } from "../schema";

const read = vi.hoisted(() => vi.fn());
vi.mock("@/components/ai-edition/regenerateAutomaticDirection", () => ({
	readProjectDirectionObservations: read,
}));

import { requestDirectionObservations } from "./directionObservations";

describe("agent direction observation cache", () => {
	it("polls one analysis and returns its recordings", async () => {
		const document = createEmptyDocument({ projectId: "ready", title: "Ready" });
		const recordings = [{ assetId: "a", cursorTelemetry: [] }];
		read.mockResolvedValueOnce(recordings);
		expect(requestDirectionObservations(document).status).toBe("analyzing");
		await Promise.resolve();
		expect(requestDirectionObservations(document)).toEqual({ status: "ready", recordings });
		expect(read).toHaveBeenCalledTimes(1);
	});
	it("reports an analysis failure before allowing a fresh retry", async () => {
		const document = createEmptyDocument({ projectId: "failed", title: "Failed" });
		read.mockRejectedValueOnce(new Error("missing microphone"));
		expect(requestDirectionObservations(document).status).toBe("analyzing");
		await Promise.resolve();
		expect(requestDirectionObservations(document)).toMatchObject({
			status: "failed",
			error: expect.stringContaining("missing microphone"),
		});
		read.mockResolvedValueOnce([]);
		expect(requestDirectionObservations(document).status).toBe("analyzing");
		await Promise.resolve();
	});
});
