#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "yaml";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(SCRIPT_DIR, "..");
const EXACT_SOURCE = "${{ needs.resolve-source.outputs.source_sha }}";
const CALL_SOURCE = "${{ inputs.source_sha || github.sha }}";

function workflow(root, name) {
	return parse(fs.readFileSync(path.join(root, ".github", "workflows", name), "utf8"));
}

function requireValue(condition, message) {
	if (!condition) throw new Error(message);
}

function steps(job) {
	return Array.isArray(job?.steps) ? job.steps : [];
}

function findStep(job, name) {
	return steps(job).find((step) => step.name === name);
}

function checkoutStep(job) {
	return steps(job).find((step) => String(step.uses ?? "").startsWith("actions/checkout@"));
}

function needs(job) {
	return Array.isArray(job?.needs) ? job.needs : job?.needs ? [job.needs] : [];
}

function checkPreparedTagWorkflow(root, name) {
	const release = workflow(root, name);
	const job = Object.values(release.jobs ?? {})[0];
	requireValue(job, `${name} needs a preparation job`);
	const workflowSteps = steps(job);
	const summary = findStep(job, "Workflow summary");
	const automatedRuns = workflowSteps
		.filter((step) => step !== summary)
		.map((step) => String(step.run ?? ""))
		.join("\n");
	requireValue(
		!/(?:^|\s)git\s+tag(?:\s|$)|gh\s+workflow\s+run\s+build\.yml/m.test(automatedRuns),
		`${name} must prepare a source but never create a tag or dispatch a release build`,
	);
	const summaryRun = String(summary?.run ?? "");
	requireValue(
		summaryRun.includes("gpg.format=ssh") &&
			summaryRun.includes("tag -s") &&
			summaryRun.includes("steps.prepare.outputs.source_sha"),
		`${name} must show how to sign the exact prepared source locally`,
	);
}

export function checkReleaseWorkflowContract(root = DEFAULT_ROOT) {
	const build = workflow(root, "build.yml");
	const helper = workflow(root, "build-whisper-stt.yml");
	const supply = workflow(root, "supply-chain.yml");
	requireValue(
		build.permissions?.contents === "read" && build.permissions?.actions === "read",
		"Build workflow must default to read-only contents and Actions access",
	);

	const resolver = build.jobs?.["resolve-source"];
	requireValue(resolver, "Build workflow needs a resolve-source job");
	requireValue(
		checkoutStep(resolver)?.with?.ref === "${{ github.sha }}" &&
			checkoutStep(resolver)?.with?.["fetch-depth"] === 0,
		"Source resolver must inspect the exact event commit and complete tag history",
	);
	const resolveStep = findStep(resolver, "Verify the selected commit and signed release tag");
	requireValue(
		resolveStep?.env?.KLIPPT_RELEASE_PUBLIC_KEY === "${{ vars.KLIPPT_RELEASE_PUBLIC_KEY }}",
		"Release tag verification must use the external repository trust key",
	);

	for (const reusableName of ["supply-chain", "build-whisper-stt"]) {
		const job = build.jobs?.[reusableName];
		requireValue(
			needs(job).includes("resolve-source"),
			`${reusableName} must wait for source resolution`,
		);
		requireValue(
			job?.with?.source_sha === EXACT_SOURCE,
			`${reusableName} must receive the exact resolved source SHA`,
		);
	}

	for (const jobName of ["build-windows", "build-windows-store", "build-macos", "build-linux"]) {
		const job = build.jobs?.[jobName];
		const dependencies = needs(job);
		for (const dependency of ["resolve-source", "supply-chain", "build-whisper-stt"]) {
			requireValue(dependencies.includes(dependency), `${jobName} must wait for ${dependency}`);
		}
		requireValue(
			checkoutStep(job)?.with?.ref === EXACT_SOURCE,
			`${jobName} must check out the resolved source SHA`,
		);
		const stage = steps(job).find((step) => step.name === "Stage whisper-stt binaries");
		requireValue(
			stage?.env?.KLIPPT_HELPER_RUN_ID === "${{ github.run_id }}" &&
				stage?.env?.KLIPPT_SOURCE_SHA === EXACT_SOURCE,
			`${jobName} must stage a source-bound helper from the caller run`,
		);
	}
	const signing = findStep(build.jobs?.["build-macos"], "Resolve macOS signing");
	requireValue(
		build.jobs?.["build-macos"]?.environment?.name ===
			"${{ needs.resolve-source.outputs.is_release == 'true' && 'release' || 'artifact-build' }}",
		"Mac release signing secrets must be isolated from artifact-only builds",
	);
	requireValue(
		signing?.env?.IS_RELEASE === "${{ needs.resolve-source.outputs.is_release }}" &&
			String(signing?.run).includes("A signed release cannot publish an ad-hoc Mac build"),
		"Signed releases must fail closed when Apple signing is unavailable",
	);

	const publish = build.jobs?.["publish-release"];
	requireValue(publish?.environment === "release", "Publishing must use the release environment");
	requireValue(
		publish?.concurrency?.group === "klippt-production-release-publish" &&
			publish?.concurrency?.["cancel-in-progress"] === false,
		"Production releases must use one shared non-cancelling publisher",
	);
	requireValue(
		publish?.permissions?.contents === "write" && publish?.permissions?.actions === "write",
		"Only publishing may receive release write permissions",
	);
	requireValue(
		String(publish?.if).includes("needs.resolve-source.outputs.is_release == 'true'"),
		"Publishing must require a verified release source",
	);
	requireValue(
		checkoutStep(publish)?.with?.ref === EXACT_SOURCE,
		"Publisher must check out the resolved source SHA",
	);
	requireValue(
		checkoutStep(publish)?.with?.["persist-credentials"] === false,
		"Publisher checkout must not persist its write-capable workflow token",
	);
	const stageFeed = findStep(publish, "Stage the owned update feed");
	const releaseOrder = findStep(publish, "Confirm this release is newest");
	const draft = findStep(publish, "Create or resume the draft release");
	requireValue(
		stageFeed?.env?.KLIPPT_SOURCE_SHA === EXACT_SOURCE,
		"The public feed must record the resolved source SHA",
	);
	requireValue(
		releaseOrder?.env?.KLIPPT_SOURCE_SHA === EXACT_SOURCE &&
			releaseOrder?.env?.KLIPPT_RELEASE_VERSION === "${{ steps.release.outputs.version }}" &&
			String(releaseOrder?.run).includes("check-update-release-order.mjs") &&
			steps(publish).indexOf(releaseOrder) < steps(publish).indexOf(draft),
		"The publisher must reject an older public release before it mutates release state",
	);
	const immutableFeed = findStep(publish, "Publish immutable update artifacts");
	const publishDraft = findStep(publish, "Publish the verified GitHub draft");
	const mutableFeed = findStep(publish, "Publish mutable update manifests");
	const verifyFeed = findStep(publish, "Verify the public update feed");
	requireValue(
		steps(publish).indexOf(draft) < steps(publish).indexOf(immutableFeed) &&
			steps(publish).indexOf(immutableFeed) < steps(publish).indexOf(mutableFeed) &&
			steps(publish).indexOf(mutableFeed) < steps(publish).indexOf(verifyFeed) &&
			steps(publish).indexOf(verifyFeed) < steps(publish).indexOf(publishDraft),
		"The draft, immutable files, public release, mutable feeds, and verification must run in safe order",
	);
	requireValue(
		String(immutableFeed?.run).includes("--immutable-only") &&
			String(immutableFeed?.run).includes("--if-none-match '*'"),
		"Immutable public files must use create-only writes and exact public verification",
	);
	requireValue(
		String(mutableFeed?.run).includes(
			"for manifest in latest.yml latest-mac.yml latest-linux.yml latest.json",
		),
		"Mutable feed publication must update every validated Electron and Klippt manifest",
	);
	requireValue(
		String(verifyFeed?.run).includes("verify-published-release.mjs") &&
			String(verifyFeed?.run).includes("--source-sha"),
		"The complete public feed must be fetched and hash-verified",
	);
	requireValue(
		draft?.env?.GH_TOKEN === "${{ secrets.KLIPPT_RELEASE_TOKEN }}" &&
			publishDraft?.env?.GH_TOKEN === "${{ secrets.KLIPPT_RELEASE_TOKEN }}",
		"Publishing must use the release-environment Klippt token",
	);
	requireValue(
		draft?.env?.SOURCE_SHA === EXACT_SOURCE &&
			String(draft?.run).includes("--draft") &&
			String(draft?.run).includes("--verify-tag") &&
			String(draft?.run).includes('--target "$SOURCE_SHA"') &&
			!String(draft?.run).includes("--clobber"),
		"The GitHub release must be a non-clobbering draft bound to the verified tag and source",
	);

	requireValue(
		helper.on?.workflow_call?.inputs?.source_sha?.required === true,
		"Helper workflow needs source_sha",
	);
	for (const job of Object.values(helper.jobs ?? {})) {
		requireValue(
			checkoutStep(job)?.with?.ref === CALL_SOURCE,
			"Every helper build must check out the caller source SHA",
		);
		requireValue(
			steps(job).some((step) => String(step.run ?? "").includes("helper-provenance.mjs create")),
			"Every helper build must emit a provenance manifest",
		);
	}

	requireValue(
		supply.on?.workflow_call?.inputs?.source_sha,
		"Supply-chain workflow needs source_sha",
	);
	for (const [jobName, job] of Object.entries(supply.jobs ?? {})) {
		const sourceCheckout = steps(job).find(
			(step) =>
				String(step.uses ?? "").startsWith("actions/checkout@") &&
				!String(step.name ?? "").includes("Semgrep rules"),
		);
		if (sourceCheckout) {
			requireValue(
				sourceCheckout.with?.ref === CALL_SOURCE,
				`${jobName} must inspect the caller source SHA`,
			);
		}
	}

	checkPreparedTagWorkflow(root, "prerelease.yml");
	checkPreparedTagWorkflow(root, "promote.yml");
	const announce = workflow(root, "announce-release.yml");
	const announceJob = announce.jobs?.announce;
	const closeMilestone = findStep(announceJob, "Close the stable release milestone");
	requireValue(
		String(closeMilestone?.if).includes("steps.ctx.outputs.kind == 'stable'") &&
			String(closeMilestone?.run).includes("release-milestone-close.mjs"),
		"Stable milestones must close only after a published release event or explicit replay",
	);
	return { packageJobs: 4, helperJobs: Object.keys(helper.jobs ?? {}).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const result = checkReleaseWorkflowContract();
	console.log(
		`Release workflow binds ${result.packageJobs} package jobs and ${result.helperJobs} helper jobs to one source`,
	);
}
