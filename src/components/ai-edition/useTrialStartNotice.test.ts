import { describe, expect, it } from "vitest";
import { shouldShowTrialStartNotice } from "./useTrialStartNotice";

const started = "2026-10-20T10:00:00.000Z";
const active = { status: "trial-active" as const, trialStartedAt: started };

describe("shouldShowTrialStartNotice", () => {
	it("shows once a started trial meets a visible recording", () => {
		expect(
			shouldShowTrialStartNotice({
				snapshot: active,
				hasRecording: true,
				visible: true,
				shownForTrial: null,
			}),
		).toBe(true);
	});

	it("stays quiet after the notice for this trial was shown", () => {
		expect(
			shouldShowTrialStartNotice({
				snapshot: active,
				hasRecording: true,
				visible: true,
				shownForTrial: started,
			}),
		).toBe(false);
	});

	it("waits while the window is hidden or has no recording", () => {
		const base = { snapshot: active, shownForTrial: null };
		expect(shouldShowTrialStartNotice({ ...base, hasRecording: true, visible: false })).toBe(false);
		expect(shouldShowTrialStartNotice({ ...base, hasRecording: false, visible: true })).toBe(false);
	});

	it("ignores every status other than an active trial", () => {
		for (const status of ["trial-not-started", "licensed", "expired", "offline-grace"] as const) {
			expect(
				shouldShowTrialStartNotice({
					snapshot: { status, trialStartedAt: started },
					hasRecording: true,
					visible: true,
					shownForTrial: null,
				}),
			).toBe(false);
		}
	});
});
