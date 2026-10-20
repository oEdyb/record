#!/usr/bin/env node
// Builds klippt.app and deploys it to Cloudflare Pages. Run only with the owner's approval:
//
//   npm run deploy            build, check, and show what would be deployed
//   npm run deploy -- --yes   also upload with wrangler (asks for a Cloudflare login once)
//
// It refuses while any page still carries a KLIPPT-DRAFT marker, so unapproved legal text
// cannot go live by accident.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SITE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WRANGLER = "wrangler@4.151.3";
const PROJECT = "klippt";

function files(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory()
			? files(path.join(directory, entry.name))
			: [path.join(directory, entry.name)],
	);
}

const drafts = files(path.join(SITE, "src", "pages")).filter((file) =>
	readFileSync(file, "utf8").includes("KLIPPT-DRAFT"),
);
if (drafts.length > 0) {
	console.error(
		`Refusing to deploy unapproved pages:\n  ${drafts.map((f) => path.relative(SITE, f)).join("\n  ")}`,
	);
	process.exit(1);
}

execFileSync("npm", ["run", "build"], { cwd: SITE, stdio: "inherit" });
if (!process.argv.includes("--yes")) {
	console.log(`\nBuilt ${path.join(SITE, "build")}. Add --yes to deploy it to Cloudflare Pages.`);
	process.exit(0);
}
execFileSync(
	"npx",
	["--yes", WRANGLER, "pages", "deploy", "build", "--project-name", PROJECT, "--branch", "main"],
	{ cwd: SITE, stdio: "inherit" },
);
