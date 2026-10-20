const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

// Keep TCC's app identity stable across local updates. Apple Development and
// Developer ID signatures with the same bundle ID are NOT the same identity.
// electron-builder can invoke afterSign even for intentionally unsigned CI
// artifacts. Those are not permission-stable local installations.
const TEAM = "LF8KF3G42Q";
const APP_ID = "co.dyberg.klippt";
const HELPERS = {
	"klippt-cursor-helper": "co.dyberg.klippt.cursor-helper",
	"klippt-screencapturekit-helper": "co.dyberg.klippt.screencapturekit-helper",
};

function requirement(identifier) {
	return `identifier "${identifier}" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${TEAM}"`;
}

function verifyMacIdentity(appPath, run = execFileSync) {
	const options = { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
	try {
		run(
			"/usr/bin/codesign",
			["--verify", "--deep", "--strict", "-R", `=${requirement(APP_ID)}`, appPath],
			options,
		);
		const nativeRoot = path.join(appPath, "Contents", "Resources", "electron", "native", "bin");
		for (const [name, identifier] of Object.entries(HELPERS)) {
			const helpers = ["darwin-arm64", "darwin-x64"]
				.map((arch) => path.join(nativeRoot, arch, name))
				.filter((candidate) => fs.existsSync(candidate));
			if (helpers.length === 0) throw new Error(`Packaged ${name} is missing`);
			for (const helper of helpers) {
				run(
					"/usr/bin/codesign",
					["--verify", "--strict", "-R", `=${requirement(identifier)}`, helper],
					options,
				);
			}
		}
	} catch (error) {
		throw new Error(
			`Refusing a Klippt build that can invalidate macOS permissions. Sign the app and capture helpers with Developer ID Application: Dyberg & Co AB (${TEAM}); preserve their identifiers. ${error.message}`,
			{ cause: error },
		);
	}
}

function isUnsignedCiArtifact(env, signingOptions = {}) {
	return (
		env.CI === "true" &&
		env.GITHUB_ACTIONS === "true" &&
		env.CSC_IDENTITY_AUTO_DISCOVERY === "false" &&
		!env.CSC_NAME?.trim() &&
		!env.CSC_LINK?.trim() &&
		!signingOptions.identity &&
		!signingOptions.sign
	);
}

exports.__testing = { APP_ID, HELPERS, requirement, verifyMacIdentity, isUnsignedCiArtifact };
exports.default = async function afterSign(context) {
	if (context.electronPlatformName !== "darwin") return;
	if (isUnsignedCiArtifact(process.env, context.packager.platformSpecificBuildOptions)) {
		console.warn(
			"Unsigned CI artifact: not approved for installation over permission-granted Klippt.",
		);
		return;
	}
	verifyMacIdentity(
		path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`),
	);
};
