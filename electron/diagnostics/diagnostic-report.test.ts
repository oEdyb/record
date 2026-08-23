import { describe, expect, it } from "vitest";
import { createDiagnosticReport, sanitizeDiagnosticText } from "./diagnostic-report";

const environment = {
	appVersion: "1.0.0",
	platform: "darwin" as const,
	arch: "arm64",
	osRelease: "25.0.0",
	osVersion: "macOS",
	totalMemoryMB: 16_384,
	nodeVersion: "22",
	electronVersion: "39",
	chromeVersion: "140",
};

describe("diagnostic report", () => {
	it("redacts credentials and local identity", () => {
		const input =
			"Bearer abc.def user@example.com +46 76 191 80 66 /Users/olle/movie.mp4?access_token=secret password=hunter2";
		const result = sanitizeDiagnosticText(input);
		expect(result).not.toContain("abc.def");
		expect(result).not.toContain("user@example.com");
		expect(result).not.toContain("76 191");
		expect(result).not.toContain("/Users/olle");
		expect(result).not.toContain("secret");
		expect(result).not.toContain("hunter2");
	});

	it("ignores malformed renderer fields instead of failing the save", () => {
		const report = createDiagnosticReport({
			request: { error: { private: true }, stack: null, logs: ["safe", { private: true }] },
			environment,
			helperOutput: { windows: "", mac: "" },
			mainProcessLogs: [],
		});
		expect(report.error).toBe("");
		expect(report.stack).toBeUndefined();
		expect(report.recentLogs).toEqual(["safe"]);
	});

	it("never includes the legacy project payload", () => {
		const request = {
			error: "failed",
			logs: ["safe"],
			projectState: { transcript: "private words", mediaPath: "/Users/olle/private.mp4" },
		};
		const report = createDiagnosticReport({
			request,
			environment,
			helperOutput: { windows: "", mac: "" },
			mainProcessLogs: [],
		});
		const json = JSON.stringify(report);
		expect(json).not.toContain("private words");
		expect(json).not.toContain("private.mp4");
		expect(report.privacy.excluded).toContain("project document");
	});

	it("bounds log volume and keeps the newest entries", () => {
		const report = createDiagnosticReport({
			request: { error: "failed", logs: Array.from({ length: 300 }, (_, i) => `log-${i}`) },
			environment,
			helperOutput: { windows: "", mac: "" },
			mainProcessLogs: Array.from({ length: 300 }, (_, i) => ({
				timestampMs: i,
				level: "info" as const,
				text: `main-${i}`,
			})),
		});
		expect(report.recentLogs).toHaveLength(250);
		expect(report.recentLogs[0]).toBe("log-50");
		expect(report.mainProcessLogs).toHaveLength(250);
		expect(report.mainProcessLogs[0].text).toBe("main-50");
	});
});
