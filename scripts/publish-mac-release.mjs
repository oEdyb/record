#!/usr/bin/env node
// Publishes a release staged by scripts/release-mac.mjs to updates.dyberg.co/klippt (Cloudflare
// R2) with rclone. Immutable artifacts go first and are verified on the public host; the mutable
// manifests that point customers at them go last.
//
//   node scripts/publish-mac-release.mjs --root release/<version>/update-release        dry run
//   node scripts/publish-mac-release.mjs --root release/<version>/update-release --yes  upload
//
// Needs R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY in the environment (an R2 API
// token scoped to the bucket). The secrets reach rclone through its environment, never argv.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { checkPublicReleaseOrder } from "./check-update-release-order.mjs";
import { verifyPublishedRelease } from "./verify-published-release.mjs";

const BASE_URL = "https://updates.dyberg.co/klippt";
const MANIFESTS = ["latest.yml", "latest-mac.yml", "latest-linux.yml", "latest.json"];
const IMMUTABLE_CACHE = "Cache-Control: public, max-age=31536000, immutable";
const MUTABLE_CACHE = "Cache-Control: no-cache, no-store, must-revalidate";

/** Uploads in publication order: every immutable file, then the manifests present. */
export function publicationPlan(fileNames) {
	const files = [...fileNames].sort();
	return {
		immutable: files.filter((name) => !MANIFESTS.includes(name)),
		manifests: MANIFESTS.filter((name) => files.includes(name)),
	};
}

export function rcloneUploadArgs({ file, bucket, accountId, name, manifest }) {
	return [
		"copyto",
		file,
		`:s3:${bucket}/klippt/${name}`,
		"--s3-provider",
		"Cloudflare",
		"--s3-endpoint",
		`https://${accountId}.r2.cloudflarestorage.com`,
		"--s3-no-check-bucket",
		"--header-upload",
		manifest ? MUTABLE_CACHE : IMMUTABLE_CACHE,
		...(manifest
			? [
					"--header-upload",
					`Content-Type: ${name.endsWith(".json") ? "application/json" : "text/yaml"}`,
				]
			: ["--immutable"]),
	];
}

export function parseArguments(args) {
	const options = { yes: false, bucket: "klippt-updates" };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--yes") options.yes = true;
		else if (arg === "--root") options.root = args[++index];
		else if (arg === "--bucket") options.bucket = args[++index];
		else throw new Error(`Unknown option: ${arg}`);
	}
	if (!options.root) throw new Error("--root <staged release directory> is required");
	return options;
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const root = path.resolve(options.root);
	const latest = JSON.parse(fs.readFileSync(path.join(root, "latest.json"), "utf8"));
	const sourceSha = latest.source?.commit;
	if (!sourceSha)
		throw new Error("latest.json has no source commit; stage it with release-mac.mjs");
	const plan = publicationPlan(
		fs
			.readdirSync(root, { withFileTypes: true })
			.filter((e) => e.isFile())
			.map((e) => e.name),
	);

	const order = await checkPublicReleaseOrder({
		version: latest.version,
		sourceSha,
		baseUrl: BASE_URL,
	});
	console.log(`Klippt ${latest.version} (${sourceSha.slice(0, 12)}): ${order}`);
	console.log(`Immutable, in this order:\n  ${plan.immutable.join("\n  ")}`);
	console.log(`Then manifests:\n  ${plan.manifests.join("\n  ")}`);
	if (!options.yes) {
		console.log("\nDry run. Nothing was uploaded. Add --yes to publish.");
		return;
	}

	const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
	const missing = Object.entries({ R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY })
		.filter(([, value]) => !value)
		.map(([name]) => name);
	if (missing.length > 0) throw new Error(`Missing ${missing.join(", ")}`);
	const env = {
		...process.env,
		RCLONE_S3_ACCESS_KEY_ID: R2_ACCESS_KEY_ID,
		RCLONE_S3_SECRET_ACCESS_KEY: R2_SECRET_ACCESS_KEY,
	};
	const upload = (name, manifest) =>
		execFileSync(
			"rclone",
			rcloneUploadArgs({
				file: path.join(root, name),
				bucket: options.bucket,
				accountId: R2_ACCOUNT_ID,
				name,
				manifest,
			}),
			{ env, stdio: "inherit" },
		);

	for (const name of plan.immutable) upload(name, false);
	await verifyPublishedRelease({ root, baseUrl: BASE_URL, immutableOnly: true });
	for (const name of plan.manifests) upload(name, true);
	await verifyPublishedRelease({ root, baseUrl: BASE_URL, expectedSourceSha: sourceSha });
	console.log(`\nPublished and verified Klippt ${latest.version} at ${BASE_URL}/latest.json`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`\nPublish stopped: ${error.message}`);
		process.exit(1);
	});
}
