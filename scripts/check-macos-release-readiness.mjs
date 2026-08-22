#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const warnings = [];

function run(command, args) {
	try {
		return {
			ok: true,
			output: execFileSync(command, args, {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			}),
		};
	} catch (error) {
		return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
	}
}

if (process.platform !== "darwin") {
	failures.push("The public macOS release must be prepared on macOS.");
}

const builderPath = path.join(root, "electron-builder.json5");
const entitlementsPath = path.join(root, "macos.entitlements");
const builder = fs.readFileSync(builderPath, "utf8");

if (!/"productName"\s*:\s*"Klippt"/.test(builder)) {
	failures.push("electron-builder.json5 must package the product as Klippt.");
}
if (!/"hardenedRuntime"\s*:\s*true/.test(builder)) {
	failures.push("Hardened Runtime must be enabled.");
}
if (!fs.existsSync(entitlementsPath)) {
	failures.push("macos.entitlements is missing.");
}

const notaryVersionResult = run("xcrun", ["notarytool", "--version"]);
const notaryVersion = notaryVersionResult.output.trim();
if (!notaryVersionResult.ok || !notaryVersion) {
	failures.push("Apple notarytool is unavailable. Install and select full Xcode.");
}

const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
const developerIdIdentity = identities.output
	.split("\n")
	.map((line) => line.trim())
	.find((line) => line.includes('"Developer ID Application:'));

if (!developerIdIdentity) {
	failures.push(
		"No Developer ID Application certificate is installed. Apple Development certificates cannot ship a public Mac app.",
	);
}

const notaryProfile = process.env.NOTARY_PROFILE?.trim();
if (notaryProfile) {
	const history = run("xcrun", ["notarytool", "history", "--keychain-profile", notaryProfile]);
	if (!history.ok) {
		failures.push(`The notarytool keychain profile '${notaryProfile}' is not usable.`);
	}
} else {
	warnings.push(
		"NOTARY_PROFILE is not set. Set it before a local notarized build, or use the six GitHub signing secrets documented in technical-documentation/engineering/release-and-secrets.md.",
	);
}

console.log("Klippt macOS release readiness\n");
for (const warning of warnings) console.log(`WARN  ${warning}`);
for (const failure of failures) console.log(`BLOCK ${failure}`);

if (failures.length > 0) {
	console.log(
		"\nNext: join the paid Apple Developer Program, create a Developer ID Application certificate, and run this check again.",
	);
	process.exit(1);
}

console.log(`OK    ${developerIdIdentity}`);
console.log(`OK    Apple notarytool ${notaryVersion}`);
console.log("\nThis Mac is ready to sign a Klippt release.");
