#!/usr/bin/env node
// Builds, signs, notarizes, staples, and stages a macOS Apple Silicon release on this Mac.
// It replaces the macOS half of build.yml so a release never depends on hosted CI.
//
//   node scripts/release-mac.mjs                 full build, notarize, and stage
//   node scripts/release-mac.mjs --skip-native   reuse the helpers already in electron/native/bin
//   node scripts/release-mac.mjs --rehearsal     build, notarize, and staple only; stages nothing
//
// A rehearsal proves signing and notarization while the dependency approval or notices are not
// yet signed off. Its output is never publishable: the release gates it skips are the reason.
//
// Nothing here uploads. `scripts/publish-mac-release.mjs` publishes a staged release.

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEAM_ID = "LF8KF3G42Q";
const SIGNER = `Dyberg & Co AB (${TEAM_ID})`;
const TARGET = "darwin-arm64";
const DEFAULT_NOTARY_PROFILE = "klippt-notary";

export function releaseFileNames(version) {
	return {
		dmg: `Klippt-macOS-Apple-Silicon-${version}.dmg`,
		zip: `Klippt-Mac-arm64-${version}.zip`,
		sidecar: "update-info-arm64.json",
	};
}

/** The signing identity name electron-builder and codesign both accept, or null. */
export function findDeveloperIdIdentity(findIdentityOutput) {
	const wanted = `"Developer ID Application: ${SIGNER}"`;
	return findIdentityOutput.split("\n").some((line) => line.includes(wanted)) ? SIGNER : null;
}

export function notaryProfileSetupCommand(profile) {
	return `xcrun notarytool store-credentials ${profile} --apple-id <your Apple ID email> --team-id ${TEAM_ID}`;
}

/** notarytool exits 0 for an Invalid submission too; only "Accepted" may be stapled. */
export function assertNotaryAccepted(result) {
	if (!result?.id) throw new Error("notarytool returned no submission ID");
	if (result.status !== "Accepted") {
		throw new Error(`Notarization ${result.id} finished as ${result.status ?? "unknown"}`);
	}
}

export function parseArguments(args) {
	const options = {
		skipNative: false,
		allowDirty: false,
		allowUnconfiguredCommerce: false,
		rehearsal: false,
	};
	for (const arg of args) {
		if (arg === "--skip-native") options.skipNative = true;
		else if (arg === "--rehearsal") options.rehearsal = true;
		else if (arg === "--allow-dirty") options.allowDirty = true;
		else if (arg === "--allow-unconfigured-commerce") options.allowUnconfiguredCommerce = true;
		else throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

function run(command, args, options = {}) {
	console.log(`\n$ ${[command, ...args].join(" ")}`);
	execFileSync(command, args, { cwd: ROOT, stdio: "inherit", ...options });
}

function read(command, args, options = {}) {
	return execFileSync(command, args, { cwd: ROOT, encoding: "utf8", ...options });
}

function step(title) {
	console.log(`\n=== ${title}`);
}

/** The signed dependency approval and the shipped notices must hold before anything is built. */
async function releaseGateProblem() {
	const scripts = path.join(ROOT, "scripts");
	try {
		const { verifyApprovedDependencies } = await import(
			pathToFileURL(path.join(scripts, "check-approved-dependencies.mjs")).href
		);
		verifyApprovedDependencies(ROOT);
		const { verifyThirdPartyInventory } = await import(
			pathToFileURL(path.join(scripts, "generate-third-party-inventory.mjs")).href
		);
		await verifyThirdPartyInventory({ root: ROOT });
		return null;
	} catch (error) {
		return (
			`Release gate failed: ${error.message}\n` +
			"After reviewing the dependency inputs, the owner re-signs them with:\n\n" +
			"    ssh-keygen -Y sign -f ~/.ssh/klippt_dependency_approval -n klippt-dependency-approval supply-chain/approved-dependency-inputs.json\n\n" +
			"then regenerates the notices with: node scripts/generate-third-party-inventory.mjs --write"
		);
	}
}

async function preflight(options, notaryProfile) {
	step("Preflight");
	if (process.platform !== "darwin" || process.arch !== "arm64") {
		throw new Error("Run the macOS release on an Apple Silicon Mac.");
	}
	const status = read("git", ["status", "--porcelain"]).trim();
	if (status && !options.allowDirty) {
		throw new Error(`Commit or stash these changes first, or pass --allow-dirty:\n${status}`);
	}
	const identity = findDeveloperIdIdentity(
		read("security", ["find-identity", "-v", "-p", "codesigning"]),
	);
	if (!identity) {
		throw new Error(`No "Developer ID Application: ${SIGNER}" certificate is in the keychain.`);
	}
	try {
		read("xcrun", ["notarytool", "history", "--keychain-profile", notaryProfile], {
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch {
		throw new Error(
			`The notarytool keychain profile "${notaryProfile}" is missing or unusable.\n` +
				`Run this once yourself; it asks for an app-specific password and stores it in the Keychain:\n\n    ${notaryProfileSetupCommand(notaryProfile)}\n`,
		);
	}
	const gateProblem = await releaseGateProblem();
	if (gateProblem && !options.rehearsal) throw new Error(gateProblem);
	if (gateProblem) console.warn(`REHEARSAL: ${gateProblem}`);
	const { commercialReleaseProblem } = await import(
		pathToFileURL(path.join(ROOT, "scripts", "commercial-config.mjs")).href
	);
	const problem = commercialReleaseProblem();
	if (problem && !options.allowUnconfiguredCommerce) {
		throw new Error(`${problem}\nPass --allow-unconfigured-commerce for a free private build.`);
	}
	if (problem) console.warn(`WARNING: ${problem}`);
	return identity;
}

function buildNative(sourceSha) {
	step("Build native helpers");
	const env = {
		...process.env,
		OPENSCREEN_MAC_HELPER_ARCHS: "arm64",
		KLIPPT_PARAKEET_ARCHS: "arm64",
	};
	run("npm", ["run", "build:native:mac"], { env });
	run("npm", ["run", "build:native:parakeet:mac"], { env });
	run("npm", ["run", "fetch:ffmpeg:mac"], { env });
	run("npm", ["run", "build:native:compositor:mac"], { env });
	run("npm", ["run", "build:whisper-binaries"], { env });
	run("node", [
		"scripts/helper-provenance.mjs",
		"create",
		"--directory",
		`electron/native/bin/${TARGET}`,
		"--helper",
		"whisper-stt",
		"--source-sha",
		sourceSha,
		"--workflow-run-id",
		"0",
		"--target",
		TARGET,
		"--dependency-source",
		"electron/native/whisper-stt/CMakeLists.txt",
		"--build-root",
		".cache/whisper-stt-build",
		"--toolchain",
		`node=${process.version}`,
		"--toolchain",
		`cmake=${read("cmake", ["--version"]).split("\n")[0]}`,
		"--toolchain",
		`compiler=${read("clang", ["--version"]).split("\n")[0]}`,
		"--toolchain",
		"runner=local-mac",
	]);
}

function findApp(releaseDir) {
	const appDir = path.join(releaseDir, "mac-arm64");
	const app = fs.existsSync(appDir)
		? fs.readdirSync(appDir).find((name) => name.endsWith(".app"))
		: undefined;
	if (!app) throw new Error(`No .app bundle in ${appDir}`);
	return path.join(appDir, app);
}

function verifyApp(app) {
	step("Verify the signed app");
	const executable = read("/usr/libexec/PlistBuddy", [
		"-c",
		"Print :CFBundleExecutable",
		`${app}/Contents/Info.plist`,
	]).trim();
	const archs = read("lipo", ["-archs", `${app}/Contents/MacOS/${executable}`]).trim();
	if (!archs.split(" ").includes("arm64")) throw new Error(`App binary is ${archs}, not arm64`);
	run("codesign", ["--verify", "--deep", "--strict", app]);
	const expected = read("/usr/libexec/PlistBuddy", [
		"-c",
		"Print :CFBundleIdentifier",
		`${app}/Contents/Info.plist`,
	]).trim();
	const output = spawnSync("codesign", ["-dv", "--verbose=2", app], { encoding: "utf8" }).stderr;
	if (!output.includes(`Identifier=${expected}`)) {
		throw new Error(`The app is not signed with its own identifier ${expected}`);
	}
	if (!output.includes(`TeamIdentifier=${TEAM_ID}`))
		throw new Error("The app is not signed by Dyberg");
}

function createDmg(app, dmg, identity) {
	step("Create and sign the DMG");
	const staging = `${dmg}.staging`;
	fs.rmSync(staging, { recursive: true, force: true });
	fs.rmSync(dmg, { force: true });
	fs.mkdirSync(staging, { recursive: true });
	run("ditto", [app, path.join(staging, path.basename(app))]);
	fs.symlinkSync("/Applications", path.join(staging, "Applications"));
	run("hdiutil", [
		"create",
		"-srcfolder",
		staging,
		"-volname",
		"Klippt",
		"-fs",
		"HFS+",
		"-fsargs",
		"-c c=64,a=16,e=16",
		"-format",
		"UDBZ",
		dmg,
	]);
	fs.rmSync(staging, { recursive: true, force: true });
	run("hdiutil", ["verify", dmg]);
	run("codesign", ["--force", "--sign", identity, "--timestamp", dmg]);
}

function notarize(dmg, notaryProfile, logDir) {
	step("Notarize (this usually takes a few minutes)");
	let output;
	try {
		output = read("xcrun", [
			"notarytool",
			"submit",
			dmg,
			"--keychain-profile",
			notaryProfile,
			"--wait",
			"--timeout",
			"30m",
			"--output-format",
			"json",
		]);
	} catch (error) {
		output = error.stdout ?? "";
		if (!output) throw error;
	}
	const result = JSON.parse(output);
	console.log(JSON.stringify(result, null, 2));
	if (result.id) {
		const logPath = path.join(logDir, `notary-${result.id}.json`);
		run("xcrun", ["notarytool", "log", result.id, "--keychain-profile", notaryProfile, logPath]);
	}
	assertNotaryAccepted(result);
}

function stapleAndCheck(dmg, app) {
	step("Staple and check Gatekeeper");
	run("xcrun", ["stapler", "staple", dmg]);
	run("xcrun", ["stapler", "staple", app]);
	run("xcrun", ["stapler", "validate", dmg]);
	run("xcrun", ["stapler", "validate", app]);
	run("codesign", ["--verify", "--deep", "--strict", app]);
	run("spctl", ["-a", "-vv", "-t", "install", dmg]);
	run("spctl", ["-a", "-vv", "-t", "exec", app]);
}

function createUpdateZip(app, zip, version, sidecar) {
	step("Create the update ZIP");
	fs.rmSync(zip, { force: true });
	run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", app, zip]);
	const entries = read("unzip", ["-Z1", zip]);
	if (!entries.includes(`${path.basename(app)}/Contents/MacOS/`)) {
		throw new Error(`${zip} does not contain the app bundle root`);
	}
	run("node", ["scripts/mac-update-feed.mjs", "describe", zip, version, sidecar]);
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	const notaryProfile = process.env.NOTARY_PROFILE?.trim() || DEFAULT_NOTARY_PROFILE;
	const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
	const sourceSha = read("git", ["rev-parse", "HEAD"]).trim();
	const releaseDir = path.join(ROOT, "release", version);
	const artifacts = path.join(releaseDir, "artifacts");
	const staged = path.join(releaseDir, "update-release");
	const names = releaseFileNames(version);

	const identity = await preflight(options, notaryProfile);
	fs.rmSync(releaseDir, { recursive: true, force: true });
	fs.mkdirSync(artifacts, { recursive: true });

	if (!options.skipNative) buildNative(sourceSha);
	step("Build the app");
	run("npm", ["run", "build-vite"]);
	run("npx", ["electron-builder", "--mac", "--arm64", "--dir", "--publish", "never"], {
		env: {
			...process.env,
			CSC_NAME: identity,
			CSC_IDENTITY_AUTO_DISCOVERY: "true",
			KLIPPT_SOURCE_SHA: sourceSha,
		},
	});
	const app = findApp(releaseDir);
	verifyApp(app);

	const dmg = path.join(artifacts, names.dmg);
	createDmg(app, dmg, identity);
	notarize(dmg, notaryProfile, releaseDir);
	stapleAndCheck(dmg, app);

	if (options.rehearsal) {
		console.log(`\nRehearsal passed: ${path.relative(ROOT, dmg)} is notarized and stapled.`);
		console.log("Nothing was staged; run without --rehearsal once the release gates pass.");
		return;
	}

	const zip = path.join(artifacts, names.zip);
	const sidecar = path.join(releaseDir, names.sidecar);
	createUpdateZip(app, zip, version, sidecar);
	run("node", [
		"scripts/mac-update-feed.mjs",
		"merge",
		sidecar,
		path.join(artifacts, "latest-mac.yml"),
	]);

	step("LGPL source offer and release evidence");
	run("node", [
		"scripts/native-ffmpeg-source.mjs",
		"--package-dir",
		app,
		"--target",
		TARGET,
		"--output-dir",
		artifacts,
	]);
	run("node", ["scripts/web-demuxer-source.mjs", "--output-dir", artifacts]);
	run(
		"node",
		[
			"scripts/generate-release-inventory.mjs",
			"--output-dir",
			path.join(releaseDir, "supply-chain"),
			"--platform",
			"darwin",
			"--arch",
			"arm64",
			"--package-dir",
			app,
			"--artifact",
			dmg,
			"--artifact",
			zip,
		],
		{ env: { ...process.env, KLIPPT_SOURCE_SHA: sourceSha } },
	);

	step("Stage the update feed");
	const { stageUpdateRelease } = await import(
		pathToFileURL(path.join(ROOT, "scripts", "stage-update-release.mjs")).href
	);
	stageUpdateRelease(artifacts, version, staged, sourceSha, [TARGET]);

	console.log(`\nKlippt ${version} is notarized and staged in ${path.relative(ROOT, staged)}.`);
	console.log("Nothing was uploaded. Publish with:\n");
	console.log(`    node scripts/publish-mac-release.mjs --root ${path.relative(ROOT, staged)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(`\nRelease stopped: ${error.message}`);
		process.exit(1);
	});
}
