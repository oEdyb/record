import fs from "node:fs";
import path from "node:path";

export const LEGACY_USER_DATA_FOLDER = "openscreen";
export const USER_DATA_FOLDER = "Klippt";
/** Written into a Klippt folder chosen for a fresh install, so the choice never flips later. */
export const USER_DATA_MARKER = ".klippt-user-data";

interface UserDataLocationOptions {
	appData: string;
	override?: string;
	/** Exact-case names in appData. APFS ignores case, so upstream OpenScreen's "Openscreen"
	 *  would otherwise match the Klippt-era "openscreen" folder. */
	listAppData?: (appData: string) => string[];
	exists?: (candidate: string) => boolean;
}

function listDirectory(directory: string): string[] {
	try {
		return fs.readdirSync(directory);
	} catch {
		return [];
	}
}

/** A Klippt folder marked by an earlier fresh install wins. Otherwise an existing Klippt-era
 *  "openscreen" folder keeps being used, because projects store absolute paths into it. Only a
 *  Mac with neither starts a new Klippt folder. */
export function chooseUserDataDirectory({
	appData,
	override,
	listAppData = listDirectory,
	exists = fs.existsSync,
}: UserDataLocationOptions): string {
	const requested = override?.trim();
	if (requested) return requested;
	const klippt = path.join(appData, USER_DATA_FOLDER);
	if (exists(path.join(klippt, USER_DATA_MARKER))) return klippt;
	if (listAppData(appData).includes(LEGACY_USER_DATA_FOLDER)) {
		return path.join(appData, LEGACY_USER_DATA_FOLDER);
	}
	return klippt;
}

export function markUserDataDirectory(directory: string, appData: string): void {
	if (directory !== path.join(appData, USER_DATA_FOLDER)) return;
	try {
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(path.join(directory, USER_DATA_MARKER), "", { flag: "a" });
	} catch (error) {
		console.warn("Could not mark the Klippt data folder:", error);
	}
}
