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

exports.__testing = { MAC_UPDATE_CONFIG, writeMacUpdateConfig };

exports.default = async function afterPack(context) {
	if (context.electronPlatformName !== "darwin") return;
	writeMacUpdateConfig(context.appOutDir, context.packager.appInfo.productFilename);
};
