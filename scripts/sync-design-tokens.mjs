import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const sourcePath = `${root}src/styles/design-tokens.css`;
const targetPath = `${root}design/tokens/v4.css`;
const header = `/* GENERATED MIRROR — do not edit directly.
 * Source: src/styles/design-tokens.css
 * Run: npm run design:sync
 */\n\n`;
const expected = `${header}${await readFile(sourcePath, "utf8")}`;
const current = await readFile(targetPath, "utf8").catch(() => "");

if (current === expected) process.exit(0);

if (process.argv.includes("--check")) {
	console.error("design/tokens/v4.css is stale. Run npm run design:sync.");
	process.exit(1);
}

await writeFile(targetPath, expected);
console.info("Synced design/tokens/v4.css from the production token source.");
