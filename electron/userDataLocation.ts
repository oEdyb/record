import fs from "node:fs";
import path from "node:path";

export const LEGACY_USER_DATA_FOLDER = "openscreen";
export const USER_DATA_FOLDER = "Klippt";

interface UserDataLocationOptions {
	appData: string;
	override?: string;
	exists?: (candidate: string) => boolean;
}

/** An existing OpenScreen-era folder keeps being used, because projects store absolute paths into
 *  it. Only a Mac that never ran the old build starts in the Klippt folder. */
export function chooseUserDataDirectory({
	appData,
	override,
	exists = fs.existsSync,
}: UserDataLocationOptions): string {
	const requested = override?.trim();
	if (requested) return requested;
	const legacy = path.join(appData, LEGACY_USER_DATA_FOLDER);
	return exists(legacy) ? legacy : path.join(appData, USER_DATA_FOLDER);
}
