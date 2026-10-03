#!/usr/bin/env node
import { extractTokens } from "./metrics.mjs";

// Fresh-agent evaluation runner (plan phase 7). For each case: clone the source
// project through the Klippt agent CLI, run setup steps, collect baseline
// evidence, launch ONE agent at a time with the case prompt, collect after
// evidence, and grade end state only (Terminal-Bench rule).
//
// Usage:
//   node scripts/agent-eval/run-agent-eval.mjs --list
//   node scripts/agent-eval/run-agent-eval.mjs --agent 'codex exec - < {prompt_file}' [--case ID]...
//
// The agent command is a shell template. Placeholders: {prompt_file} {prompt}
// {case_dir} {frames_dir} {project_id} {project_path}. It runs through sh -c.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
	extractCheckCounts,
	extractHistoryEntries,
	extractRecoveredReceiptId,
	extractStagedCount,
	extractStagedCuts,
	extractTranscriptAllPage,
	gradeCase,
	listCases,
	mergeTranscriptPages,
	parseTerminalEnvelope,
	projectContentEvidence,
	projectDocumentEvidence,
	sha256File,
	sha256Text,
} from "./grader.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CASES_DIR = path.join(__dirname, "cases");
const DEFAULT_OUT_ROOT = path.join(REPO_ROOT, "artifacts", "agent-eval", "runs");
const DEFAULT_AGENT_TIMEOUT_SEC = 1800;
const CHECK_POLL_LIMIT = 24;
const CHECK_POLL_INTERVAL_MS = 5000;
const TRANSCRIPT_PAGE_LIMIT = 40;

function parseCli(argv) {
	const { values } = parseArgs({
		args: argv,
		options: {
			agent: { type: "string" },
			case: { type: "string", multiple: true, default: [] },
			out: { type: "string" },
			klippt: { type: "string" },
			"timeout-sec": { type: "string", default: String(DEFAULT_AGENT_TIMEOUT_SEC) },
			list: { type: "boolean", default: false },
		},
		strict: true,
	});
	return values;
}

/** Resolve the Klippt CLI: the phase-1 launcher, or the raw Electron invocation. */
function resolveKlippt(override) {
	if (override) return { command: override, args: [] };
	const launcher = path.join(REPO_ROOT, "scripts", "klippt");
	if (fs.existsSync(launcher)) return { command: launcher, args: [] };
	return {
		command: "env",
		args: [
			"-u",
			"ELECTRON_RUN_AS_NODE",
			path.join(REPO_ROOT, "node_modules", ".bin", "electron"),
			REPO_ROOT,
		],
	};
}

/** Run one `klippt agent` invocation; return { envelope, stdout, stderr, exitCode }. */
function klipptAgent(klippt, argv, { timeoutMs = 120_000 } = {}) {
	const result = spawnSync(klippt.command, [...klippt.args, "agent", ...argv, "--json"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		timeout: timeoutMs,
		maxBuffer: 64 * 1024 * 1024,
	});
	return {
		envelope: parseTerminalEnvelope(result.stdout ?? ""),
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		exitCode: result.status,
	};
}

function substitute(template, values) {
	return template.replace(/\{(\w+)\}/g, (match, key) =>
		key in values ? String(values[key]) : match,
	);
}

function sleepMs(ms) {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function collectCheckCounts(klippt, projectId) {
	// `check` runs background analysis: data.status is analyzing → ready|error.
	// Counts live at data.result.counts and are identical on every findings page,
	// so polling until ready (or giving up) is the whole job — no page walk.
	let last = null;
	for (let attempt = 0; attempt < CHECK_POLL_LIMIT; attempt += 1) {
		last = klipptAgent(klippt, ["check", "--project_id", projectId, "--all"]);
		const data = last.envelope?.data ?? {};
		if (data.status !== "analyzing") break;
		if (attempt + 1 < CHECK_POLL_LIMIT) sleepMs(CHECK_POLL_INTERVAL_MS);
	}
	return { counts: extractCheckCounts(last?.envelope), raw: last };
}

function collectTranscript(klippt, projectId) {
	// `transcript --all` is paged: clips continue across pages at words_offset.
	// Join every page; a page that is not an --all reply makes the evidence
	// unavailable (text null), which the grader reports as incomplete.
	const pages = [];
	let last = null;
	for (let page = 1; page <= TRANSCRIPT_PAGE_LIMIT; page += 1) {
		last = klipptAgent(klippt, [
			"transcript",
			"--project_id",
			projectId,
			"--all",
			"--page",
			String(page),
		]);
		const extract = extractTranscriptAllPage(last.envelope);
		if (extract === null) {
			return { transcript: { text: null, missingCount: null, complete: false }, raw: last };
		}
		pages.push(extract);
		if (!extract.nextPage) break;
	}
	return { transcript: mergeTranscriptPages(pages), raw: last };
}

function collectEvidence(klippt, projectId, projectPath, { needDocument, needReceiptRecovery }) {
	const staged = klipptAgent(klippt, ["staged", "--project_id", projectId]);
	const check = collectCheckCounts(klippt, projectId);
	const transcript = collectTranscript(klippt, projectId);
	const history = klipptAgent(klippt, ["history", "--project_id", projectId]);
	let hash = null;
	try {
		hash = sha256File(projectPath);
	} catch {
		hash = null;
	}
	const content = projectContentEvidence(projectPath);
	const recovery = needReceiptRecovery
		? (content?.receiptRequestIds ?? []).map((requestId) => {
				const reply = klipptAgent(klippt, [
					"receipt",
					"--project_id",
					projectId,
					"--request_id",
					requestId,
				]);
				return {
					requestId,
					recovered: extractRecoveredReceiptId(reply.envelope),
					stdout: reply.stdout,
				};
			})
		: null;
	return {
		hash,
		contentHash: content?.contentHash ?? null,
		receiptRequestIds: content?.receiptRequestIds ?? null,
		recoveredReceiptIds:
			recovery?.flatMap((item) => (item.recovered === item.requestId ? [item.requestId] : [])) ??
			null,
		stagedCount: extractStagedCount(staged.envelope),
		stagedCuts: extractStagedCuts(staged.envelope),
		checkCounts: check.counts,
		transcript: transcript.transcript,
		history: extractHistoryEntries(history.envelope),
		document: needDocument ? projectDocumentEvidence(projectPath) : null,
		raw: {
			recovery,
			staged: { stdout: staged.stdout, stderr: staged.stderr },
			check: { stdout: check.raw?.stdout ?? "" },
			history: { stdout: history.stdout },
		},
	};
}

/** Does the grader need the saved-document overlay/asset projection? */
function needsDocumentEvidence(manifest) {
	const outcome = manifest.grader?.outcome ?? {};
	return Boolean(outcome.new_overlay || outcome.swapped_overlay);
}

function probeCliVersion(klippt) {
	const reply = klipptAgent(klippt, ["skill"]);
	const data = reply.envelope?.data ?? {};
	return {
		app_version: data.app_version ?? null,
		skill_content_sha256: data.content_sha256 ?? null,
	};
}

function runAgent(template, values, { cwd, transcriptPath, timeoutSec }) {
	const command = substitute(template, values);
	const started = Date.now();
	const result = spawnSync("sh", ["-c", command], {
		cwd,
		encoding: "utf8",
		timeout: timeoutSec * 1000,
		maxBuffer: 256 * 1024 * 1024,
		env: { ...process.env, KLIPPT_EVAL_PROJECT_ID: values.project_id },
	});
	const wallTimeSec = (Date.now() - started) / 1000;
	const transcript = [
		`$ ${command}`,
		"",
		"--- stdout ---",
		result.stdout ?? "",
		"--- stderr ---",
		result.stderr ?? "",
		result.error ? `--- spawn error: ${result.error.message} ---` : "",
	].join("\n");
	fs.writeFileSync(transcriptPath, transcript, "utf8");
	return {
		exitCode: result.status,
		timedOut: result.error?.code === "ETIMEDOUT" || result.signal === "SIGTERM",
		wallTimeSec,
		tokens: extractTokens(transcript),
	};
}

function writeCaseResult(outDir, result) {
	fs.writeFileSync(
		path.join(outDir, "result.json"),
		`${JSON.stringify(result, null, 2)}\n`,
		"utf8",
	);
}

function summarize(results) {
	const lines = [
		`| Case | Status | Wall time | Tokens | Wrong-time edits | Unintended mutations |`,
		`| --- | --- | --- | --- | --- | --- |`,
	];
	for (const r of results.cases) {
		lines.push(
			`| ${r.id} | ${r.status}${r.reason ? ` (${r.reason})` : ""} | ${
				r.wall_time_sec === null ? "—" : `${r.wall_time_sec.toFixed(0)} s`
			} | ${r.tokens ?? "—"} | ${r.wrong_time_edits ?? "—"} | ${r.unintended_mutations ?? "—"} |`,
		);
	}
	return lines.join("\n");
}

function main() {
	const options = parseCli(process.argv.slice(2));
	const allCases = listCases(CASES_DIR);
	const selected =
		options.case.length > 0
			? options.case.map((id) => {
					const found = allCases.find((c) => c.manifest.id === id);
					if (!found) throw new Error(`unknown case ${id}; run with --list`);
					return found;
				})
			: allCases;

	if (options.list) {
		for (const c of selected) {
			const pending = c.manifest.pending ? ` [pending: ${c.manifest.pending}]` : "";
			console.log(`${c.manifest.id}${pending} — ${c.manifest.title}`);
		}
		return;
	}

	if (!options.agent) {
		console.error("Missing --agent '<command template>'. See scripts/agent-eval/README.md.");
		process.exit(2);
	}

	const klippt = resolveKlippt(options.klippt);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const outRoot = options.out ? path.resolve(options.out) : path.join(DEFAULT_OUT_ROOT, stamp);
	fs.mkdirSync(outRoot, { recursive: true });

	const cliVersion = probeCliVersion(klippt);
	const results = {
		date: new Date().toISOString(),
		cli_version: cliVersion.app_version,
		skill_version: cliVersion.skill_content_sha256,
		agent: options.agent,
		cases: [],
	};

	for (const evalCase of selected) {
		const { manifest } = evalCase;
		const caseOut = path.join(outRoot, manifest.id);
		const framesDir = path.join(caseOut, "frames");
		fs.mkdirSync(framesDir, { recursive: true });
		console.log(`\n=== ${manifest.id} ===`);

		if (manifest.pending) {
			const reason = `pending ${manifest.pending}: required command not in this build`;
			console.log(`SKIP ${manifest.id}: ${reason}`);
			const record = {
				id: manifest.id,
				status: "skipped",
				reason,
				wall_time_sec: null,
				tokens: null,
				wrong_time_edits: null,
				unintended_mutations: null,
			};
			writeCaseResult(caseOut, record);
			results.cases.push(record);
			continue;
		}

		const record = {
			id: manifest.id,
			status: "error",
			reason: null,
			wall_time_sec: null,
			tokens: null,
			wrong_time_edits: null,
			unintended_mutations: null,
			checks: [],
		};
		try {
			// Fresh clone per run; the source project is never opened or written.
			const clone = klipptAgent(klippt, [
				"clone",
				"--project",
				manifest.source_project,
				"--title",
				`agent-eval ${manifest.id} ${stamp}`,
			]);
			const cloneData = clone.envelope?.data;
			if (!cloneData?.project_id || !cloneData?.path) {
				throw new Error(`clone failed: ${clone.stderr || clone.stdout}`);
			}
			const projectId = cloneData.project_id;
			const projectPath = cloneData.path;
			record.clone_project_id = projectId;
			console.log(`clone: ${projectId}`);
			klipptAgent(klippt, ["open", "--project_id", projectId]);

			const values = {
				project_id: projectId,
				project_path: projectPath,
				case_dir: evalCase.dir,
				frames_dir: framesDir,
				request_id: `eval-${manifest.id}-${stamp}`,
			};

			for (const step of manifest.setup ?? []) {
				const argv = step.argv.map((arg) => substitute(arg, values));
				const reply = klipptAgent(klippt, argv);
				fs.writeFileSync(
					path.join(caseOut, `setup-${(manifest.setup ?? []).indexOf(step)}.json`),
					JSON.stringify({ argv, stdout: reply.stdout, stderr: reply.stderr }, null, 2),
					"utf8",
				);
			}

			// Baseline is collected after setup so harness mutations are not graded.
			const collectOptions = {
				needDocument: needsDocumentEvidence(manifest),
				needReceiptRecovery: manifest.grader.project_hash === "content_restored",
			};
			const baseline = collectEvidence(klippt, projectId, projectPath, collectOptions);
			fs.writeFileSync(
				path.join(caseOut, "baseline.json"),
				JSON.stringify(
					{
						hash: baseline.hash,
						contentHash: baseline.contentHash,
						receiptRequestIds: baseline.receiptRequestIds,
						recoveredReceiptIds: baseline.recoveredReceiptIds,
						recovery: baseline.raw.recovery,
						stagedCount: baseline.stagedCount,
						checkCounts: baseline.checkCounts,
						transcript_sha256:
							baseline.transcript?.text == null ? null : sha256Text(baseline.transcript.text),
						transcript_missing: baseline.transcript?.missingCount ?? null,
						history_entries: baseline.history?.length ?? null,
						overlays: baseline.document?.overlays.length ?? null,
					},
					null,
					2,
				),
				"utf8",
			);

			const promptPath = path.join(caseOut, "prompt.md");
			const renderedPrompt = substitute(evalCase.prompt, values);
			fs.writeFileSync(promptPath, renderedPrompt, "utf8");
			const transcriptPath = path.join(caseOut, "transcript.txt");
			const agentRun = runAgent(
				options.agent,
				{ ...values, prompt: renderedPrompt, prompt_file: promptPath },
				{
					cwd: caseOut,
					transcriptPath,
					timeoutSec: Number.parseInt(options["timeout-sec"], 10),
				},
			);
			record.wall_time_sec = agentRun.wallTimeSec;
			record.tokens = agentRun.tokens;
			if (agentRun.timedOut) record.reason = "agent timed out";

			const after = collectEvidence(klippt, projectId, projectPath, collectOptions);
			fs.writeFileSync(
				path.join(caseOut, "after.json"),
				JSON.stringify(
					{
						hash: after.hash,
						contentHash: after.contentHash,
						receiptRequestIds: after.receiptRequestIds,
						recoveredReceiptIds: after.recoveredReceiptIds,
						recovery: after.raw.recovery,
						stagedCount: after.stagedCount,
						checkCounts: after.checkCounts,
						transcript_missing: after.transcript?.missingCount ?? null,
						history_entries: after.history?.length ?? null,
						overlays: after.document?.overlays.length ?? null,
					},
					null,
					2,
				),
				"utf8",
			);

			// The agent transcript is telemetry, except for declared safety
			// assertions (safety.receipt_recovery) which grade it directly.
			let agentTranscript = null;
			try {
				agentTranscript = fs.readFileSync(transcriptPath, "utf8");
			} catch {
				agentTranscript = null;
			}
			const grade = gradeCase(manifest, {
				baseline,
				after,
				framesDir,
				agentTranscript,
				requestId: values.request_id,
			});
			record.status = grade.status;
			record.checks = grade.checks;
			record.unintended_mutations = grade.unintendedMutations;
			record.wrong_time_edits = grade.wrongTimeEdits;
			if (agentRun.timedOut && grade.status !== "pass") {
				record.reason = "agent timed out; end state incomplete";
			}
		} catch (error) {
			record.status = "error";
			record.reason = error instanceof Error ? error.message : String(error);
		}
		writeCaseResult(caseOut, record);
		results.cases.push(record);
		console.log(
			`${record.status.toUpperCase()} ${manifest.id}${record.reason ? `: ${record.reason}` : ""}`,
		);
	}

	fs.writeFileSync(
		path.join(outRoot, "results.json"),
		`${JSON.stringify(results, null, 2)}\n`,
		"utf8",
	);
	const summary = [
		`# agent-eval run ${results.date}`,
		"",
		`- CLI version: ${results.cli_version ?? "unknown"}`,
		`- Skill content sha256: ${results.skill_version ?? "unknown"}`,
		`- Agent: \`${results.agent}\``,
		"",
		summarize(results),
		"",
	].join("\n");
	fs.writeFileSync(path.join(outRoot, "results.md"), summary, "utf8");
	console.log(`\n${summary}\nResults: ${outRoot}`);

	const failed = results.cases.filter(
		(c) => c.status === "fail" || c.status === "error" || c.status === "incomplete",
	);
	process.exit(failed.length > 0 ? 1 : 0);
}

main();
