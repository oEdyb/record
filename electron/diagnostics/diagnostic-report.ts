import type { MainLogEntry } from "./main-log-buffer";
import type { WorkloadReport } from "./workloadTelemetry";

const MAX_TEXT_LENGTH = 64 * 1024;
const MAX_LOG_TEXT_LENGTH = 4 * 1024;
const MAX_LOG_ENTRIES = 250;

export interface DiagnosticRequest {
	error: unknown;
	stack?: unknown;
	logs?: unknown;
}

interface DiagnosticEnvironment {
	appVersion: string;
	platform: NodeJS.Platform;
	arch: string;
	osRelease: string;
	osVersion: string;
	totalMemoryMB: number;
	nodeVersion: string;
	electronVersion: string;
	chromeVersion: string;
}

export interface DiagnosticInputs {
	request: DiagnosticRequest;
	environment: DiagnosticEnvironment;
	helperOutput: { windows: string; mac: string };
	mainProcessLogs: MainLogEntry[];
	workloadReports?: WorkloadReport[];
}

function tail(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : value.slice(-maxLength);
}

/** Remove common credentials and local identity from diagnostic text. */
export function sanitizeDiagnosticText(value: string): string {
	return value
		.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer <redacted>")
		.replace(
			/([?&](?:access_?token|api_?key|auth|authorization|password|secret)=)[^&#\s]+/gi,
			"$1<redacted>",
		)
		.replace(
			/\b((?:access_?token|api_?key|authorization|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
			"$1<redacted>",
		)
		.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "<redacted-email>")
		.replace(/\+\d[\d\s().-]{7,}\d/g, "<redacted-phone>")
		.replace(/\/Users\/[^/\s]+/g, "/Users/<redacted>")
		.replace(/\\Users\\[^\\\s]+/gi, "\\Users\\<redacted>")
		.replace(/\/private\/var\/folders\/[^/\s]+\/[^/\s]+/g, "/private/var/folders/<redacted>");
}

function sanitizeBounded(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	return tail(sanitizeDiagnosticText(value), maxLength);
}

export function createDiagnosticReport(inputs: DiagnosticInputs) {
	return {
		format: "klippt-diagnostic-v1",
		timestamp: new Date().toISOString(),
		environment: inputs.environment,
		error: sanitizeBounded(inputs.request.error, MAX_TEXT_LENGTH) ?? "",
		stack: sanitizeBounded(inputs.request.stack, MAX_TEXT_LENGTH),
		recentLogs: (Array.isArray(inputs.request.logs) ? inputs.request.logs : [])
			.filter((entry): entry is string => typeof entry === "string")
			.slice(-MAX_LOG_ENTRIES)
			.map((entry) => sanitizeBounded(entry, MAX_LOG_TEXT_LENGTH) ?? ""),
		helperOutput: {
			windows: sanitizeBounded(inputs.helperOutput.windows, MAX_TEXT_LENGTH) ?? "",
			mac: sanitizeBounded(inputs.helperOutput.mac, MAX_TEXT_LENGTH) ?? "",
		},
		mainProcessLogs: inputs.mainProcessLogs.slice(-MAX_LOG_ENTRIES).map((entry) => ({
			...entry,
			text: sanitizeBounded(entry.text, MAX_LOG_TEXT_LENGTH) ?? "",
		})),
		workloadReports: inputs.workloadReports?.slice(-20) ?? [],
		privacy: {
			excluded: [
				"project document",
				"media and audio",
				"transcripts",
				"cursor and keyboard telemetry",
				"account credentials",
			],
		},
	};
}
