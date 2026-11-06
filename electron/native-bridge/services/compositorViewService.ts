import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import {
	CURSOR_THEMES,
	DEFAULT_CURSOR_SPRITES,
	resolveCursorSprites,
} from "../../../src/lib/cursor/cursorThemes";
import {
	calculateEffectiveExportDuration,
	estimateGifFileSizeBytes,
	estimateMp4FileSizeBytes,
} from "../../../src/lib/exporter/mp4ExportSettings";
import { collectExportSourcePaths } from "../../../src/native/exportSourcePaths";
import {
	AtomicExportPublisher,
	type ExportTransactionPhase,
	type ExportTransactionWarning,
} from "../../export/atomicExport";
import { assertAudioSpoolSpace } from "../../export/audioSpoolSpace";
import { ExportCancellationRegistry } from "../../export/exportCancellationRegistry";
import { renderedExportCodec } from "../../export/exportCodec";
import {
	prepareRecordingFastExport,
	type RecordingFastExportPlan,
} from "../../export/recordingFastExport";
import type {
	ClipInput,
	CompositorBackend,
	CompositorParamValue,
	CompositorViewAddon,
	CompositorViewRect,
	ExportParamsInput,
	ExportStats,
	GifExportStats,
	GifParamsInput,
	NativeFramePacket,
	RemuxStats,
	VideoExportVerifyInput,
} from "../../native/compositor-view/addon";

/**
 * ESM-safe `require` for loading the native addon
 * (`compositor_view.node`). The electron main bundle is ESM at the source
 * level; `require()` isn't available at the top level. `createRequire` keeps
 * the addon require dynamic so vite/rollup never tries to bundle the native
 * binary.
 */
const localRequire: NodeRequire = createRequire(import.meta.url) as unknown as NodeRequire;

/**
 * `existsSync` that answers for the REAL filesystem, not Electron's asar-transparent view of it.
 *
 * Electron patches `fs` so JS can read `.../app.asar/dist/wallpapers/x.jpg` as if it were a plain
 * file — that's the entire point of asar. But `existsSync` inherits the same patch: called on an
 * asar-internal path it returns `true`, even though nothing outside Electron's own patched `fs`
 * can ever open that path — the Rust addon calls the raw OS `fopen`/`CreateFile`, which has no
 * concept of asar and gets ENOENT. A candidate-probe loop built on the patched `fs.existsSync`
 * therefore locks onto the WRONG candidate (VITE_PUBLIC, pointing into the asar) before ever
 * trying the right one (`resourcesPath`, real files on disk) — confirmed by running this exact
 * check inside the packaged binary: patched `existsSync` on the asar path answered `true`.
 *
 * `original-fs` is Electron's escape hatch for precisely this: the same API, unpatched. It only
 * exists inside Electron, so fall back to plain `node:fs` where it doesn't — under plain Node
 * (tests) there is no asar patch to route around in the first place, so plain `fs` already tells
 * the truth there.
 */
function realExistsSync(candidate: string): boolean {
	try {
		return (localRequire("original-fs") as typeof fs).existsSync(candidate);
	} catch {
		return fs.existsSync(candidate);
	}
}

/**
 * Bases holding the `wallpapers/` and `cursors/` trees, most specific first.
 *
 * `VITE_PUBLIC` is right in dev (`<root>/public`) and WRONG when packaged, where it points at
 * `<resources>/app.asar/dist`: vite copies `public/` into `dist`, so the files are there — but
 * inside the asar archive. Only Electron's patched `fs` can read through an asar, and the
 * compositor is a Rust addon calling `image::open` on a raw OS path, so every themed cursor
 * sprite and every bundled wallpaper silently failed to load in an installed build. The cursor
 * fell back to its default art (a theme pick looked like it did nothing) and the background fell
 * back to a flat colour. A CUSTOM uploaded image kept working throughout, because it travels as a
 * `data:` URL the addon decodes in memory rather than a path — which is exactly the asymmetry that
 * pinned this down.
 *
 * `extraResources` copies both trees to `<resources>/{wallpapers,cursors}` as real files (see
 * electron-builder.json5, whose own "Asset layout contract" comment names this), so
 * `process.resourcesPath` is the packaged answer. Probing for existence rather than branching on
 * `app.isPackaged` keeps `--dir` staging builds and tests working too, and mirrors the
 * candidate-list idiom `ffmpegSharedBinCandidates` already uses below. Same base dir as
 * `ASSET_BASE_DIR` in electron/windows.ts, which resolves these two trees for the renderer.
 */
function sceneAssetBaseDirs(): string[] {
	return [process.env.VITE_PUBLIC, process.resourcesPath].filter(
		(dir): dir is string => typeof dir === "string" && dir.length > 0,
	);
}

// Only trusted, bundled cursor artwork is cached. User media paths still pass
// through normal validation and probes; dev public files are not cached. The
// finite catalogue bounds this cache, and a resource-root change invalidates it.
const bundledCursorPaths = new Set([
	...Object.values(DEFAULT_CURSOR_SPRITES).map((sprite) => sprite.assetPath),
	...CURSOR_THEMES.flatMap((theme) =>
		Object.values(theme.assets).map((sprite) => sprite.assetPath),
	),
]);
let sceneAssetRootsKey = "";
const packagedCursorPaths = new Map<string, string>();

/** First base under which `relativePath` actually exists, joined; null when none does (leave the
 *  scene's own value alone rather than hand the addon a path we know is not there). */
export function resolveSceneAssetPath(relativePath: string): string | null {
	const bases = sceneAssetBaseDirs();
	const rootsKey = JSON.stringify(bases);
	if (sceneAssetRootsKey !== rootsKey) {
		sceneAssetRootsKey = rootsKey;
		packagedCursorPaths.clear();
	}
	const cached = packagedCursorPaths.get(relativePath);
	if (cached) return cached;
	for (const base of bases) {
		const candidate = path.join(base, relativePath);
		if (realExistsSync(candidate)) {
			if (base === process.resourcesPath && bundledCursorPaths.has(relativePath)) {
				packagedCursorPaths.set(relativePath, candidate);
			}
			return candidate;
		}
	}
	return null;
}

/**
 * The theme's sprite set with every `assetPath` turned into an absolute on-disk path.
 *
 * Entries whose file doesn't resolve are dropped rather than passed through: the addon
 * would fail to decode them and fall back to its placeholder anyway, and a missing entry
 * lets it fall back to the arrow instead, which is closer to right.
 */
function resolveCursorSpritePaths(
	themeId: string,
): Record<string, { path: string; hotspotX: number; hotspotY: number }> {
	const resolved: Record<string, { path: string; hotspotX: number; hotspotY: number }> = {};
	for (const [type, sprite] of Object.entries(resolveCursorSprites(themeId))) {
		const absolute = resolveSceneAssetPath(sprite.assetPath);
		if (absolute) {
			resolved[type] = {
				path: absolute,
				hotspotX: sprite.hotspotX,
				hotspotY: sprite.hotspotY,
			};
		}
	}
	return resolved;
}

export function resolveSceneAssetPaths(sceneJson: string): string {
	try {
		const scene = JSON.parse(sceneJson) as {
			background?: { kind?: string; path?: string };
			cursor?: {
				theme?: string;
				cursorSprites?: Record<string, { path: string; hotspotX: number; hotspotY: number }>;
			};
		};
		let changed = false;
		const bg = scene.background;
		if (bg?.kind === "image" && typeof bg.path === "string" && bg.path.startsWith("/")) {
			// strip the leading slash so path.join keeps it under the base dir
			const resolved = resolveSceneAssetPath(bg.path.replace(/^\/+/, ""));
			if (resolved) {
				bg.path = resolved;
				changed = true;
			}
		}
		if (scene.cursor && typeof scene.cursor.theme === "string") {
			scene.cursor.cursorSprites = resolveCursorSpritePaths(scene.cursor.theme);
			changed = true;
		}
		return changed ? JSON.stringify(scene) : sceneJson;
	} catch {
		return sceneJson;
	}
}

export interface CompositorViewServiceOptions {
	/**
	 * Optional explicit override for the addon path. Has precedence over the
	 * `OPENSCREEN_COMPOSITOR_VIEW_NODE` env var and the candidate path list.
	 * Useful for poking at a locally-built `.node` without copying it into
	 * the standard search root.
	 */
	envOverride?: string | null;
	/**
	 * Directory to resolve candidate paths relative to. Defaults to
	 * `app.getAppPath()` so dev (unpackaged) and packaged setups resolve the
	 * same relative path. Tests can inject a temp directory here.
	 */
	appRoot?: string;
	isPackaged?: boolean;
	exportPublisher?: AtomicExportPublisher;
	exportJournalPath?: string;
	/** Injectable source-preserving preparation for export transaction tests. */
	recordingFastExport?: typeof prepareRecordingFastExport;
	/** Test-only/preloaded addon. Skips dynamic filesystem discovery when supplied. */
	addon?: CompositorViewAddon;
}

export type ExportSourceMetadata =
	import("../../../src/native/exportSourcePaths").ExportSourceMetadata<ClipInput>;

export interface ExportTransactionOptions {
	expectedBytes?: number;
	signal?: AbortSignal;
	onPhase?: (phase: ExportTransactionPhase) => void;
	exportId?: string;
	sourceMetadata?: ExportSourceMetadata;
}

export type PublishedExportStats<T> = T & { exportWarning?: ExportTransactionWarning };

interface SceneSpeedRegion {
	startSec: number;
	endSec: number;
	speed: number;
	clipIndex?: number | null;
}

function sceneSpeedRegions(sceneJson?: string): SceneSpeedRegion[] {
	if (!sceneJson) return [];
	try {
		const parsed = JSON.parse(sceneJson) as { speedRegions?: unknown };
		if (!Array.isArray(parsed.speedRegions)) return [];
		return parsed.speedRegions.flatMap((value): SceneSpeedRegion[] => {
			if (!value || typeof value !== "object") return [];
			const region = value as Partial<SceneSpeedRegion>;
			if (
				!Number.isFinite(region.startSec) ||
				!Number.isFinite(region.endSec) ||
				!Number.isFinite(region.speed)
			) {
				return [];
			}
			return [region as SceneSpeedRegion];
		});
	} catch {
		return [];
	}
}

interface ExportPathIdentity {
	canonicalPath: string;
	device?: bigint;
	inode?: bigint;
}

async function exportPathIdentity(file: string): Promise<ExportPathIdentity> {
	const resolved = path.resolve(file);
	try {
		const [canonicalPath, stats] = await Promise.all([
			fs.promises.realpath(resolved),
			fs.promises.stat(resolved, { bigint: true }),
		]);
		return { canonicalPath, device: stats.dev, inode: stats.ino };
	} catch {
		const parent = await fs.promises
			.realpath(path.dirname(resolved))
			.catch(() => path.dirname(resolved));
		return { canonicalPath: path.join(parent, path.basename(resolved)) };
	}
}

export async function assertExportKeepsSources(
	target: string,
	sourcePaths: readonly string[],
): Promise<void> {
	const destination = await exportPathIdentity(target);
	for (const source of sourcePaths) {
		const candidate = await exportPathIdentity(source);
		const sameFile =
			destination.device !== undefined &&
			candidate.device === destination.device &&
			candidate.inode === destination.inode;
		if (sameFile || candidate.canonicalPath === destination.canonicalPath) {
			throw new Error("Choose another file name. This file is one of the sources in this export.");
		}
	}
}

export function calculateSceneExportDuration(clips: ClipInput[], sceneJson?: string): number {
	return calculateEffectiveExportDuration(clips, sceneSpeedRegions(sceneJson));
}

type MediaDurationProbe = (path: string) => Promise<number>;

/** Resolves imported and legacy clip extents from the source container.
 * Explicit trims stay intact. Missing, provisional, and oversized ends are
 * bounded by the duration reported by the linked FFmpeg build. */
export async function resolveClipSourceDurations(
	clips: ClipInput[],
	probeMediaDuration: MediaDurationProbe,
): Promise<ClipInput[]> {
	const durationByPath = new Map<string, Promise<number>>();
	const probeOnce = (sourcePath: string): Promise<number> => {
		let duration = durationByPath.get(sourcePath);
		if (!duration) {
			duration = probeMediaDuration(sourcePath).catch((error: unknown) => {
				const detail = error instanceof Error ? error.message : String(error);
				throw new Error(`Unable to read media duration for ${sourcePath}: ${detail}`);
			});
			durationByPath.set(sourcePath, duration);
		}
		return duration;
	};

	return Promise.all(
		clips.map(async (clip) => {
			const sourceDurationSec = await probeOnce(clip.screenPath);
			if (!Number.isFinite(sourceDurationSec) || sourceDurationSec <= 0) {
				throw new Error(`Unable to read media duration for ${clip.screenPath}.`);
			}
			if (
				!Number.isFinite(clip.sourceStartSec) ||
				clip.sourceStartSec < 0 ||
				clip.sourceStartSec >= sourceDurationSec
			) {
				throw new Error(`Clip starts outside its source media: ${clip.screenPath}.`);
			}
			const hasExplicitEnd =
				Number.isFinite(clip.sourceEndSec) && clip.sourceEndSec > clip.sourceStartSec;
			return {
				...clip,
				sourceEndSec: hasExplicitEnd
					? Math.min(clip.sourceEndSec, sourceDurationSec)
					: sourceDurationSec,
			};
		}),
	);
}

export interface VideoBufferPublishSpec extends VideoExportVerifyInput {
	expectedBytes: number;
}

function defaultAppRoot(): string {
	try {
		return app.getAppPath();
	} catch {
		// bare-node test environment — fall back to the source tree root
		// via this file's location (service lives at
		// electron/native-bridge/services/, project root is four levels up).
		const here = path.dirname(fileURLToPath(import.meta.url));
		return path.resolve(here, "..", "..", "..", "..");
	}
}

function defaultIsPackaged(): boolean {
	try {
		return app.isPackaged;
	} catch {
		return false;
	}
}

function platformArchTag(): string {
	const platformPrefix =
		process.platform === "win32" ? "win32" : process.platform === "darwin" ? "darwin" : "linux";
	return process.arch === "arm64" ? `${platformPrefix}-arm64` : `${platformPrefix}-x64`;
}

/**
 * Bases that may hold `electron/native/…`, most specific first.
 *
 * `appRoot` alone is not enough, and was not enough on either side of the packaged
 * line:
 *
 *  - **Unpackaged.** `app.getAppPath()` resolves to the directory holding the entry
 *    script, i.e. `<repo>/dist-electron` — the entry every dev run uses, `npm run dev`
 *    included. Joining `electron/native/...` onto that gives
 *    `<repo>/dist-electron/electron/native/...`, which no build step ever writes, so
 *    the loader fell through to "addon not present; running as no-op" and the editor
 *    silently ran without a compositor. Walking up to the first ancestor that actually
 *    has an `electron/native` finds the checkout root.
 *  - **Packaged.** `electron/native/bin/<tag>/**` ships exclusively through
 *    `extraResources` (see electron-builder.json5's mac/win/linux blocks), so it lands
 *    at `<resources>/electron/native/bin/<tag>` and is never inside `app.asar` — the
 *    `.asar` → `.asar.unpacked` rewrite below cannot reach it either, since the file
 *    was never in the archive. `process.resourcesPath` is the base that holds it.
 *
 * Same pair of bases `ffmpegSharedBinCandidates` already walks for the ffmpeg dir; the
 * addon needs it for exactly the same reason.
 */
function nativeAssetBaseDirs(appRoot: string): string[] {
	const bases = [appRoot];
	// Bounded walk: dist-electron → repo root is one level, but a nested layout could
	// be deeper. Stop at the filesystem root rather than looping.
	let dir = appRoot;
	for (let i = 0; i < 4; i += 1) {
		const parent = path.dirname(dir);
		if (parent === dir) {
			break;
		}
		dir = parent;
		if (fs.existsSync(path.join(dir, "electron", "native"))) {
			bases.push(dir);
			break;
		}
	}
	if (typeof process.resourcesPath === "string" && process.resourcesPath.length > 0) {
		bases.push(process.resourcesPath);
	}
	return bases;
}

export function buildCandidatePaths(
	appRoot: string,
	isPackaged: boolean,
	envOverride: string | null | undefined,
): string[] {
	const tag = platformArchTag();
	const perBase = nativeAssetBaseDirs(appRoot).flatMap((base) => [
		path.join(base, "electron", "native", "bin", tag, "compositor_view.node"),
		path.join(base, "electron", "native", "compositor-view", "build", "compositor_view.node"),
	]);
	const ordered = [envOverride, ...perBase].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (!isPackaged) {
		return ordered;
	}
	// in packaged builds, references inside `app.asar/...` must be
	// rewritten to `.asar.unpacked/...` so dynamic `require()` can load the
	// native binary (matches the capture-helper resolution policy).
	return ordered.map((candidate) => candidate.replace(/\.asar([/\\])/, ".asar.unpacked$1"));
}

/**
 * The dev-vendored ffmpeg tree, read from the pin that already exists rather
 * than named a second time here: `crates/.cargo/config.toml`'s `FFMPEG_DIR`.
 *
 * That pin is the one thing the addon is actually built against (see the
 * config's own comment), so the DLL basenames it imports — `avcodec-62.dll` and
 * friends — only match the tree it points at. Restating the folder name in this
 * file is precisely how the previous entry rotted: the pin moved off a floating
 * `master-latest` snapshot onto the fixed `n8.1.2` release and this list went on
 * probing a directory that no longer existed. Nothing broke, because the search
 * silently fell through to the vendored `electron/native/bin/<tag>` — which is
 * what makes the rot worth removing rather than tolerating.
 *
 * Returns null when there is no config to read: packaged builds ship no
 * `crates/` at all, and the candidate list simply starts one entry later.
 */
function pinnedFfmpegDir(appRoot: string): string | null {
	const crateDir = path.join(appRoot, "crates");
	let toml: string;
	try {
		toml = fs.readFileSync(path.join(crateDir, ".cargo", "config.toml"), "utf8");
	} catch {
		return null;
	}
	// Both spellings cargo accepts carry the path as the first quoted string on
	// the line: `FFMPEG_DIR = "…"` and `FFMPEG_DIR = { value = "…", relative = true }`.
	const value = /^\s*FFMPEG_DIR\s*=.*?"([^"]+)"/m.exec(toml)?.[1];
	if (!value) {
		return null;
	}
	// `relative = true` resolves against the directory the config governs (the
	// crate root), which is also what the pin's own comment documents.
	return path.isAbsolute(value) ? value : path.join(crateDir, value);
}

/**
 * Directories that may hold the ffmpeg shared DLLs (avcodec/avformat/avutil/…)
 * the addon dynamically links against. Node's `require()` of a native addon
 * does a Win32 `LoadLibrary` under the hood, which resolves dependent DLLs via
 * the standard search order — including `PATH` — so whichever of these exists
 * gets prepended to `process.env.PATH` before the `require()` in
 * `tryLoadAddon`.
 *
 * Order: the dev-only vendored location first (absent outside a source
 * checkout — see `pinnedFfmpegDir`), then the arch-tagged bin dir under
 * `appRoot` (dev / `electron-builder --dir` unpacked staging), then the *same*
 * dir under `process.resourcesPath` — required for real packaged installers,
 * since `electron/native/bin/**` ships exclusively via `extraResources` (see
 * `electron-builder.json5`'s `files` list, which only packs
 * `dist`/`dist-electron`) and is never inside `app.getAppPath()` there.
 * Same appPath/resourcePath pattern the other native binaries in this
 * directory use.
 */
export function ffmpegSharedBinCandidates(appRoot: string): string[] {
	const tag = platformArchTag();
	const resourcesPath =
		typeof process.resourcesPath === "string" && process.resourcesPath.length > 0
			? process.resourcesPath
			: null;
	const devDir = pinnedFfmpegDir(appRoot);
	return [
		...(devDir ? [path.join(devDir, "bin")] : []),
		path.join(appRoot, "electron", "native", "bin", tag),
		...(resourcesPath ? [path.join(resourcesPath, "electron", "native", "bin", tag)] : []),
	];
}

/** Prepends the first existing ffmpeg shared-DLL dir to `PATH` (no-op if already present or none found). */
function ensureFfmpegSharedDllsOnPath(appRoot: string): void {
	if (process.platform !== "win32") {
		return;
	}
	const dir = ffmpegSharedBinCandidates(appRoot).find((candidate) => fs.existsSync(candidate));
	if (!dir) {
		return;
	}
	const current = process.env.PATH ?? "";
	if (current.split(path.delimiter).includes(dir)) {
		return;
	}
	process.env.PATH = `${dir}${path.delimiter}${current}`;
}

function tryLoadAddon(candidates: string[]): CompositorViewAddon | null {
	for (const candidate of candidates) {
		try {
			// only attempt the require when the file actually exists
			// — `require()` of a missing native module throws a noisy
			// MODULE_NOT_FOUND that pollutes the renderer console.
			if (!fs.existsSync(candidate)) {
				continue;
			}
			const loaded = localRequire(candidate) as unknown;
			if (loaded && typeof loaded === "object") {
				return loaded as CompositorViewAddon;
			}
		} catch (err) {
			// log and try the next candidate — a single broken build
			// shouldn't kill the addon entirely, but silently swallowing this
			// is exactly what made a missing-ffmpeg-DLL failure look like a
			// generic "addon not present" no-op.
			console.warn(`[compositor-view] failed to load addon candidate ${candidate}:`, err);
		}
	}
	return null;
}

export class CompositorViewService {
	private readonly options: CompositorViewServiceOptions;
	private readonly exportPublisher: AtomicExportPublisher;
	private readonly rects = new Map<number, CompositorViewRect>();
	private readonly exportCancellations = new ExportCancellationRegistry();
	private addon: CompositorViewAddon | null = null;
	private loadAttempted = false;
	private syntheticIdCounter = 0;

	constructor(options: CompositorViewServiceOptions = {}) {
		this.options = options;
		if (options.addon) {
			this.addon = options.addon;
			this.loadAttempted = true;
		}
		const appRoot = options.appRoot ?? defaultAppRoot();
		let journalRoot = appRoot;
		try {
			journalRoot = app.getPath("userData");
		} catch {
			// Bare-node tests have no initialized Electron app.
		}
		this.exportPublisher =
			options.exportPublisher ??
			new AtomicExportPublisher({
				journalPath:
					options.exportJournalPath ?? path.join(journalRoot, "export-transactions.json"),
			});
	}

	initializeExportRecovery(): Promise<void> {
		return this.exportPublisher.initialize();
	}

	cancelExport(exportId: string): boolean {
		this.exportCancellations.transition({ type: "cancel", id: exportId, at: Date.now() });
		if (this.exportCancellations.active(exportId)) this.addon?.cancelExport?.(exportId);
		return true;
	}
	private registerActiveExport(exportId: string, controller: AbortController): void {
		if (
			!this.exportCancellations.transition({
				type: "register",
				id: exportId,
				controller,
				at: Date.now(),
			})
		)
			throw new Error("An export with this ID is already running.");
	}

	private ensureAddon(): CompositorViewAddon | null {
		if (this.loadAttempted) {
			return this.addon;
		}
		this.loadAttempted = true;

		const envOverride =
			this.options.envOverride ?? process.env.OPENSCREEN_COMPOSITOR_VIEW_NODE ?? null;
		const appRoot = this.options.appRoot ?? defaultAppRoot();
		const isPackaged = this.options.isPackaged ?? defaultIsPackaged();

		ensureFfmpegSharedDllsOnPath(appRoot);
		const candidates = buildCandidatePaths(appRoot, isPackaged, envOverride);
		const loaded = tryLoadAddon(candidates);
		if (!loaded) {
			// single log line, exactly as specified — repeated
			// ensureAddon calls just return null without spamming the console.
			console.log("[compositor-view] native addon not present; running as no-op");
			return null;
		}
		this.addon = loaded;
		return this.addon;
	}

	/** Pure frame planning: loads the addon but creates no view, decoder or GPU context. */
	evaluateSceneGeometry(requestJson: string): string | null {
		const addon = this.ensureAddon() as
			| (CompositorViewAddon & { evaluateSceneGeometry?: (request: string) => string })
			| null;
		return addon?.evaluateSceneGeometry?.(requestJson) ?? null;
	}

	async renderAudioOverlayStem(
		requestJson: string,
		outputPath: string,
		jobId: string,
	): Promise<string> {
		const addon = this.ensureAddon();
		if (!addon?.renderAudioOverlayStem)
			throw new Error("Native audio overlay renderer unavailable");
		return addon.renderAudioOverlayStem(requestJson, outputPath, jobId);
	}

	/** True when the native `.node` addon was successfully loaded. */
	hasAddon(): boolean {
		return this.ensureAddon() !== null;
	}

	/** Which backend the compositor will use on this machine.
	 *
	 *  `"none"` when the addon is absent — no native path at all, so there is nothing to
	 *  warn about; that is the pure-web/dev case, not a degraded GPU. Callers must not
	 *  read `"none"` as "slow", only `"cpu"` means that. */
	probeBackend(): CompositorBackend {
		const addon = this.ensureAddon();
		if (!addon) {
			return "none";
		}
		try {
			return addon.probeBackend();
		} catch (err) {
			// An older `.node` predates probeBackend. Treat as unknown rather than
			// crashing the bridge: a stale addon should not take the editor down.
			console.warn("[compositor-view] probeBackend unavailable:", err);
			return "none";
		}
	}

	/** Allocates an offscreen compositor view sized to `rect.width`x`rect.height`.
	 *  `rect.x` / `rect.y` are vestigial (ignored native-side) — the renderer
	 *  keeps them on the wire so the existing `CompositorViewRect` shape stays
	 *  source-compatible. No HWND/native-window-handle is passed: there's no
	 *  OS window to parent to. */
	createView(
		rect: CompositorViewRect,
		paths?: { screenPath?: string; webcamPath?: string; cursorPath?: string },
	): number {
		const addon = this.ensureAddon();
		if (!addon) {
			// synthetic negative ids let callers do bookkeeping
			// (cleanup in destroyView) without crashing when no native view
			// exists. Each call gets a fresh id so multiple no-op views
			// stay independent.
			this.syntheticIdCounter -= 1;
			const id = this.syntheticIdCounter;
			this.rects.set(id, rect);
			return id;
		}
		const id = addon.createView(rect, paths?.screenPath, paths?.webcamPath, paths?.cursorPath);
		this.rects.set(id, rect);
		return id;
	}

	setRect(id: number, rect: CompositorViewRect): void {
		const addon = this.ensureAddon();
		this.rects.set(id, rect);
		if (!addon) {
			return;
		}
		addon.setRect(id, rect);
	}

	/** Reads the most recently rendered frame for `id` as a self-describing packet
	 *  (`{ gen, width, height, data }`), but only if its generation is newer than
	 *  `sinceGen`. Returns `null` when the addon is absent, no frame is ready yet,
	 *  OR the caller already holds the current generation — the idle path, where
	 *  `null` comes back without any buffer copy. Byte order is RGBA. */
	readFrame(id: number, sinceGen: number): NativeFramePacket | null {
		const addon = this.ensureAddon();
		if (!addon) {
			return null;
		}
		return addon.readFrame(id, sinceGen);
	}

	setParam(id: number, key: string, value: CompositorParamValue): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.setParam(id, key, value);
	}

	setPlaying(id: number, playing: boolean): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.setPlaying(id, playing);
	}

	syncTransport(
		id: number,
		generation: number,
		playing: boolean,
		screenPath: string,
		webcamPath: string,
		webcamOffsetSec: number,
		clipIndex: number,
		sourceTimeSec: number,
	): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.syncTransport(
			id,
			generation,
			playing,
			screenPath,
			webcamPath,
			webcamOffsetSec,
			clipIndex,
			sourceTimeSec,
		);
	}

	presentTime(id: number, seconds: number): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.presentTime(id, seconds);
	}

	setScene(id: number, sceneJson: string): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.setScene(id, resolveSceneAssetPaths(sceneJson));
	}

	setActiveClip(
		id: number,
		screenPath: string,
		webcamPath: string,
		webcamOffsetSec: number,
		clipIndex: number,
		sourceTimeSec: number,
	): void {
		const addon = this.ensureAddon();
		if (!addon) {
			return;
		}
		addon.setActiveClip(id, screenPath, webcamPath, webcamOffsetSec, clipIndex, sourceTimeSec);
	}

	shutdownPreviews(): void {
		this.addon?.shutdownPreviews();
		this.rects.clear();
	}

	destroyView(id: number): void {
		const addon = this.ensureAddon();
		this.rects.delete(id);
		if (!addon) {
			return;
		}
		addon.destroyView(id);
	}

	/** Native multiclip export (real timeline -> MP4). Auto-pauses previews via the addon.
	 *  `sceneJson` — same scene as the live preview (background/layout/webcam/cursor/effects);
	 *  goes through the same asset-path resolution as `setScene` (wallpaper image, cursor theme
	 *  sprite) since the native process can't resolve renderer-relative URLs either.
	 *  `onProgress` — see `export()` above.
	 *  Returns null when the addon is absent. */
	async exportMulti(
		clips: ClipInput[],
		outPath?: string,
		sceneJson?: string,
		params?: ExportParamsInput,
		onProgress?: (frames: number) => void,
		transaction?: ExportTransactionOptions,
	): Promise<PublishedExportStats<ExportStats> | null> {
		const addon = this.ensureAddon();
		if (!addon) {
			return null;
		}
		const target = outPath ?? path.join(app.getPath("temp"), "openscreen-native-export.mp4");
		if (!addon.verifyVideoExport || !addon.cancelExport || !addon.probeMediaDuration) {
			throw new Error("Native export verification is unavailable. Rebuild the compositor addon.");
		}
		const exportId = transaction?.exportId ?? randomUUID();
		const controller = new AbortController();
		this.registerActiveExport(exportId, controller);
		const forwardAbort = () => controller.abort(transaction?.signal?.reason);
		if (transaction?.signal?.aborted) forwardAbort();
		else transaction?.signal?.addEventListener("abort", forwardAbort, { once: true });
		try {
			const resolvedSceneJson = sceneJson ? resolveSceneAssetPaths(sceneJson) : undefined;
			await assertExportKeepsSources(target, collectExportSourcePaths(clips, resolvedSceneJson));
			const width = Math.max(2, params?.width ?? 1920) & ~1;
			const height = Math.max(2, params?.height ?? 1080) & ~1;
			const sourceDurations = new Map<string, number>();
			const resolvedClips = await resolveClipSourceDurations(clips, async (sourcePath) => {
				const duration = await addon.probeMediaDuration!(sourcePath);
				sourceDurations.set(sourcePath, duration);
				return duration;
			});
			// The copy path keeps the recording's own codec; only a render can switch.
			const renderParams = { ...params, codec: renderedExportCodec(params) };
			let fastExport: RecordingFastExportPlan | null = null;
			if (params?.preserveRecordingSource) {
				try {
					fastExport = await (this.options.recordingFastExport ?? prepareRecordingFastExport)({
						clips: resolvedClips,
						sceneJson,
						params,
						sourceDurationsSec: resolvedClips.map((clip) => sourceDurations.get(clip.screenPath)!),
						signal: controller.signal,
						onProgress,
					});
				} catch (error) {
					if (controller.signal.aborted) throw error;
					console.warn(
						"[CompositorViewService] Source preservation unavailable; rendering recording.",
						error,
					);
				}
			}
			const durationEstimate = calculateSceneExportDuration(resolvedClips, sceneJson);
			const expectedBytes = Math.max(
				fastExport?.expectedBytes ?? 0,
				estimateMp4FileSizeBytes({
					durationSec: durationEstimate,
					videoBitrate: params?.bitrate ?? 8_000_000,
					hasAudio: resolvedClips.some((clip) => clip.hasAudio),
				}),
			);
			let copiedRecording = false;
			let exportWarning: ExportTransactionWarning | undefined;
			const stats = await this.exportPublisher.publish({
				finalPath: target,
				expectedBytes,
				signal: controller.signal,
				onPhase: transaction?.onPhase,
				onWarning: (warning) => {
					exportWarning = warning;
				},
				render: async (stagingPath, signal) => {
					const cancelNative = () => addon.cancelExport?.(exportId);
					signal.addEventListener("abort", cancelNative, { once: true });
					try {
						if (fastExport) {
							try {
								const result = await fastExport.render(stagingPath, signal, onProgress);
								if (signal.aborted) throw signal.reason ?? new Error("Recording export cancelled.");
								// A sparse capture or unusual source may be playable but fail the
								// final-file contract. Verify before committing to this fast path.
								await addon.verifyVideoExport!(
									stagingPath,
									{
										width,
										height,
										fps: fastExport.fps,
										durationS: fastExport.durationS,
										codec: params?.codec === "h265" ? "h265" : "h264",
									},
									exportId,
								);
								if (signal.aborted) throw signal.reason ?? new Error("Recording export cancelled.");
								copiedRecording = true;
								return result;
							} catch (error) {
								if (signal.aborted) throw error;
								console.warn(
									"[CompositorViewService] Source preservation failed verification; rendering recording.",
									error,
								);
								await fs.promises.rm(stagingPath, { force: true });
							}
						}
						// The program spool is written even for silent takes, at output length:
						// slow speed regions make it longer than the source.
						const sourceSec = resolvedClips.map((clip) => clip.sourceEndSec - clip.sourceStartSec);
						const stretch = Math.max(
							1,
							durationEstimate /
								Math.max(
									1e-6,
									sourceSec.reduce((sum, sec) => sum + sec, 0),
								),
						);
						await assertAudioSpoolSpace(sourceSec.map((sec) => sec * stretch));
						const operation = addon.exportMulti(
							resolvedClips,
							stagingPath,
							resolvedSceneJson,
							renderParams,
							onProgress,
							exportId,
						);
						if (signal.aborted) cancelNative();
						return await operation;
					} finally {
						signal.removeEventListener("abort", cancelNative);
					}
				},
				verify: async (stagingPath, stats, signal) => {
					if (copiedRecording) return;
					const cancelNative = () => addon.cancelExport?.(exportId);
					signal.addEventListener("abort", cancelNative, { once: true });
					const outputFps =
						copiedRecording && fastExport ? fastExport.fps : stats.frames / stats.videoDurationS;
					const verifyInput: VideoExportVerifyInput = {
						width,
						height,
						fps: outputFps,
						durationS: stats.videoDurationS,
						codec: copiedRecording
							? params?.codec === "h265"
								? "h265"
								: "h264"
							: renderParams.codec,
					};
					try {
						const operation = addon.verifyVideoExport?.(stagingPath, verifyInput, exportId);
						if (signal.aborted) cancelNative();
						await operation;
					} finally {
						signal.removeEventListener("abort", cancelNative);
					}
				},
			});
			return exportWarning ? { ...stats, exportWarning } : stats;
		} finally {
			this.exportCancellations.transition({ type: "finish", id: exportId, controller });
			transaction?.signal?.removeEventListener("abort", forwardAbort);
		}
	}

	/** Native GIF export. Same inputs as `exportMulti` — one clip list, one scene —
	 *  because it is the same render: both drive `walk_composited_timeline` in the
	 *  compositor crate and differ only in the encoder. The scene carries background,
	 *  layout, webcam and cursor, so there is no GIF-specific input.
	 *
	 *  Returns null when the addon is absent, which the renderer surfaces as a failed
	 *  export — there is no longer a renderer-side GIF path to fall back to. */
	async exportGif(
		clips: ClipInput[],
		outPath?: string,
		sceneJson?: string,
		params?: GifParamsInput,
		onProgress?: (frames: number) => void,
		transaction?: ExportTransactionOptions,
	): Promise<PublishedExportStats<GifExportStats> | null> {
		const addon = this.ensureAddon();
		if (!addon) {
			return null;
		}
		const target = outPath ?? path.join(app.getPath("temp"), "openscreen-native-export.gif");
		if (!addon.verifyGifExport || !addon.cancelExport || !addon.probeMediaDuration) {
			throw new Error("Native GIF verification is unavailable. Rebuild the compositor addon.");
		}
		const exportId = transaction?.exportId ?? randomUUID();
		const controller = new AbortController();
		this.registerActiveExport(exportId, controller);
		const forwardAbort = () => controller.abort(transaction?.signal?.reason);
		if (transaction?.signal?.aborted) forwardAbort();
		else transaction?.signal?.addEventListener("abort", forwardAbort, { once: true });
		try {
			const resolvedSceneJson = sceneJson ? resolveSceneAssetPaths(sceneJson) : undefined;
			await assertExportKeepsSources(target, collectExportSourcePaths(clips, resolvedSceneJson));
			const width = params?.width ?? 854;
			const height = params?.height ?? 480;
			const resolvedClips = await resolveClipSourceDurations(
				clips,
				addon.probeMediaDuration.bind(addon),
			);
			const durationEstimate = calculateSceneExportDuration(resolvedClips, sceneJson);
			const fps = params?.fps ?? 12;
			const expectedBytes = estimateGifFileSizeBytes({
				durationSec: durationEstimate,
				width,
				height,
				fps,
			});
			let exportWarning: ExportTransactionWarning | undefined;
			const stats = await this.exportPublisher.publish({
				finalPath: target,
				expectedBytes,
				signal: controller.signal,
				onPhase: transaction?.onPhase,
				onWarning: (warning) => {
					exportWarning = warning;
				},
				render: async (stagingPath, signal) => {
					const cancelNative = () => addon.cancelExport?.(exportId);
					signal.addEventListener("abort", cancelNative, { once: true });
					try {
						const operation = addon.exportGif(
							resolvedClips,
							stagingPath,
							resolvedSceneJson,
							params,
							onProgress,
							exportId,
						);
						if (signal.aborted) cancelNative();
						return await operation;
					} finally {
						signal.removeEventListener("abort", cancelNative);
					}
				},
				verify: async (stagingPath, stats, signal) => {
					const cancelNative = () => addon.cancelExport?.(exportId);
					signal.addEventListener("abort", cancelNative, { once: true });
					try {
						const operation = addon.verifyGifExport?.(
							stagingPath,
							{
								width,
								height,
								fps,
								durationS: stats.frames / fps,
							},
							exportId,
						);
						if (signal.aborted) cancelNative();
						await operation;
					} finally {
						signal.removeEventListener("abort", cancelNative);
					}
				},
			});
			return exportWarning ? { ...stats, exportWarning } : stats;
		} finally {
			this.exportCancellations.transition({ type: "finish", id: exportId, controller });
			transaction?.signal?.removeEventListener("abort", forwardAbort);
		}
	}

	async publishVideoBuffer(
		videoData: ArrayBuffer,
		outPath: string,
		spec: VideoBufferPublishSpec,
		transaction: ExportTransactionOptions & { sourceMetadata: ExportSourceMetadata },
	): Promise<ExportTransactionWarning | undefined> {
		const addon = this.ensureAddon();
		if (!addon?.verifyVideoExport || !addon.cancelExport) {
			throw new Error("Native export verification is unavailable. Rebuild the compositor addon.");
		}
		const bytes = Buffer.from(videoData);
		const exportId = transaction?.exportId ?? randomUUID();
		const controller = new AbortController();
		this.registerActiveExport(exportId, controller);
		const forwardAbort = () => controller.abort(transaction?.signal?.reason);
		if (transaction?.signal?.aborted) forwardAbort();
		else transaction?.signal?.addEventListener("abort", forwardAbort, { once: true });
		try {
			if (!transaction.sourceMetadata || transaction.sourceMetadata.clips.length === 0) {
				throw new Error("Export source metadata is required before publication.");
			}
			const sourceSceneJson = transaction.sourceMetadata.sceneJson
				? resolveSceneAssetPaths(transaction.sourceMetadata.sceneJson)
				: undefined;
			await assertExportKeepsSources(
				outPath,
				collectExportSourcePaths(
					transaction.sourceMetadata.clips,
					sourceSceneJson,
					transaction.sourceMetadata.additionalSourcePaths,
				),
			);
			let exportWarning: ExportTransactionWarning | undefined;
			await this.exportPublisher.publish({
				finalPath: outPath,
				expectedBytes: spec.expectedBytes,
				signal: controller.signal,
				onPhase: transaction?.onPhase,
				onWarning: (warning) => {
					exportWarning = warning;
				},
				render: async (stagingPath, signal) => {
					if (signal.aborted) throw new DOMException("Export cancelled.", "AbortError");
					await fs.promises.writeFile(stagingPath, bytes);
				},
				verify: async (stagingPath, _result, signal) => {
					const cancelNative = () => addon.cancelExport?.(exportId);
					signal.addEventListener("abort", cancelNative, { once: true });
					try {
						const operation = addon.verifyVideoExport?.(stagingPath, spec, exportId);
						if (signal.aborted) cancelNative();
						await operation;
					} finally {
						signal.removeEventListener("abort", cancelNative);
					}
				},
			});
			return exportWarning;
		} finally {
			this.exportCancellations.transition({ type: "finish", id: exportId, controller });
			transaction?.signal?.removeEventListener("abort", forwardAbort);
		}
	}

	/** Stream-copy `inputPath` to `outputPath` through libavformat's matroska muxer.
	 *  No re-encode: the packets are copied verbatim and only the container is rebuilt,
	 *  which is what gives the output a real `Duration`, `Cues` and `SeekHead`.
	 *
	 *  `outputPath` must be a TEMPORARY path — the caller renames it over the original
	 *  only once this resolves, so a failure leaves the recording untouched. See
	 *  `electron/recording/webm-seek-index.ts`, the only caller.
	 *
	 *  Returns null when the addon is absent, or when it predates this export (a stale
	 *  `.node` from an earlier build): the caller then keeps the file as it is rather
	 *  than treating a missing optimisation as a failed save. */
	async remuxSeekable(inputPath: string, outputPath: string): Promise<RemuxStats | null> {
		const addon = this.ensureAddon();
		if (!addon?.remuxSeekable) {
			return null;
		}
		return addon.remuxSeekable(inputPath, outputPath);
	}
}
