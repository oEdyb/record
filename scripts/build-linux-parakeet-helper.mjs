// Builds Clean cut's Linux speech helper (electron/native/parakeet-linux) and
// vendors it to electron/native/bin/linux-<arch>/klippt-parakeet-stt, where
// candidateParakeetBinaryPaths() in electron/transcript/parakeetProcess.ts finds
// it. Same file name as the macOS helper: the app drives both over one protocol.
//
// sherpa-onnx is linked statically. Its -sys build script downloads the matching
// prebuilt archive from the k2-fsa GitHub release; set SHERPA_ONNX_ARCHIVE_DIR to
// a folder holding that archive to build offline.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") {
	console.log("Skipping Linux Parakeet helper build: host platform is not Linux.");
	process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const helperName = "klippt-parakeet-stt";
const crateDir = path.join(root, "electron", "native", "parakeet-linux");
const tag = `linux-${process.arch === "arm64" ? "arm64" : "x64"}`;
const outDir = path.join(root, "electron", "native", "bin", tag);

const build = spawnSync(
	"cargo",
	["build", "--release", "--manifest-path", path.join(crateDir, "Cargo.toml")],
	{ cwd: crateDir, stdio: "inherit" },
);
if (build.error) {
	console.error(`Failed to start cargo: ${build.error.message}`);
	process.exit(1);
}
if (build.status !== 0) process.exit(build.status ?? 1);

const builtBinary = path.join(crateDir, "target", "release", helperName);
if (!fs.existsSync(builtBinary)) {
	console.error(`cargo build succeeded but ${builtBinary} was not found.`);
	process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
const dest = path.join(outDir, helperName);
// Copy beside it, then rename over it: writing into a running executable fails with
// ETXTBSY, while a rename leaves a running helper on its own inode.
const staged = `${dest}.new`;
fs.copyFileSync(builtBinary, staged);
fs.chmodSync(staged, 0o755);
fs.renameSync(staged, dest);
console.log(`Copied ${dest}`);
