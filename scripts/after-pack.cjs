const fs = require("node:fs");
const path = require("node:path");

const MAC_UPDATE_CONFIG = [
	"provider: generic",
	"url: https://updates.dyberg.co/klippt",
	"updaterCacheDirName: klippt-updater",
	"",
].join("\n");

function writeMacUpdateConfig(appOutDir, productFilename) {
	const resourcesDir = path.join(appOutDir, `${productFilename}.app`, "Contents", "Resources");
	if (!fs.existsSync(resourcesDir) || !fs.statSync(resourcesDir).isDirectory()) {
		throw new Error(`macOS resources directory is missing: ${resourcesDir}`);
	}
	const outputPath = path.join(resourcesDir, "app-update.yml");
	fs.writeFileSync(outputPath, MAC_UPDATE_CONFIG, "utf8");
	return outputPath;
}

function resolvePackagedAppPath(context) {
	const productFilename = context.packager.appInfo.productFilename;
	switch (context.electronPlatformName) {
		case "darwin":
		case "mas":
			return path.join(context.appOutDir, `${productFilename}.app`);
		case "win32":
			return path.join(context.appOutDir, `${productFilename}.exe`);
		case "linux":
			return path.join(context.appOutDir, context.packager.executableName || productFilename);
		default:
			throw new Error(`Unsupported Electron packaging platform: ${context.electronPlatformName}`);
	}
}

async function buildFuseConfig() {
	const { FuseV1Options, FuseVersion } = await import("@electron/fuses");
	return {
		version: FuseVersion.V1,
		strictlyRequireAllFuses: true,
		[FuseV1Options.RunAsNode]: false,
		[FuseV1Options.EnableCookieEncryption]: true,
		[FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
		[FuseV1Options.EnableNodeCliInspectArguments]: false,
		[FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
		[FuseV1Options.OnlyLoadAppFromAsar]: true,
		[FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
		// Packaged content and approved local media use the restricted klippt:// protocol.
		[FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
		[FuseV1Options.WasmTrapHandlers]: true,
	};
}

async function hardenElectronBinary(context) {
	const { flipFuses } = await import("@electron/fuses");
	return flipFuses(resolvePackagedAppPath(context), await buildFuseConfig());
}

exports.__testing = {
	MAC_UPDATE_CONFIG,
	buildFuseConfig,
	resolvePackagedAppPath,
	writeMacUpdateConfig,
};

exports.default = async function afterPack(context) {
	if (context.electronPlatformName === "darwin") {
		writeMacUpdateConfig(context.appOutDir, context.packager.appInfo.productFilename);
	}
	await hardenElectronBinary(context);
};
