import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonDurably } from "../filesystem/durableJson";

export interface EntitlementStateStore<T> {
	read(): Promise<T | undefined>;
	write(value: T): Promise<void>;
}

export function createEntitlementStateStore<T>(userDataPath: string): EntitlementStateStore<T> {
	const filePath = path.join(userDataPath, "entitlement.json");
	return {
		async read() {
			try {
				return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
				console.warn("Could not read entitlement state:", error);
				return undefined;
			}
		},
		write(value) {
			return writeJsonDurably(filePath, value);
		},
	};
}
