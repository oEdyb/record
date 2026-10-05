import type { AgentHistoryIntent } from "./agentHistory";
// DocumentService — main-process owner of v3 AxcutDocument projects.
// Persists one .klippt JSON per project under userData/projects/ (the file
// carries its own `schemaVersion`, so migration keys off the content, not the
// extension). Older builds wrote these same documents as `.openscreen` and
// `.axcut`; those remain readable and are copied to `.klippt` on first access.
// Slim port of
// axcut's apps/server/src/services/document-service.ts (no separate paths.ts —
// uses app.getPath("userData") directly; no Python probe_media — assets carry
// only path metadata, duration is filled in by the renderer).
//
// ponytail: Phase 1 surface area is intentionally narrow (list / get / create
// / save / addAsset / removeAsset). ops/history/agent runtime land in Phase 6.

import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { removeAssetFromDocument } from "../../src/lib/ai-edition/document/assets";
import { createId } from "../../src/lib/ai-edition/document/ids";
import {
	type AxcutAsset,
	type AxcutDocument,
	createEmptyDocument,
	documentSchema,
	migrateRawDocumentToCurrent,
} from "../../src/lib/ai-edition/schema";
import {
	LEGACY_PROJECT_FILE_EXTENSIONS,
	PROJECT_FILE_EXTENSION,
} from "../../src/lib/projectFileFormat";
import { relinkProjectMedia } from "../media/projectMediaRelinker";
import {
	type ProjectTransactionReceipt,
	type ProjectTransactionSnapshot,
	ProjectTransactionStore,
	type ProjectTransactionVersion,
	parseProjectTransactionRecord,
} from "./projectTransactions";

const CANONICAL_PROJECT_FILE_EXTENSION = `.${PROJECT_FILE_EXTENSION}`;
const LEGACY_PROJECT_FILE_SUFFIXES = LEGACY_PROJECT_FILE_EXTENSIONS.map(
	(extension) => `.${extension}`,
);

export interface ProjectSummary {
	id: string;
	title: string;
	updatedAt: string;
	assetCount: number;
}

export interface AddAssetInput {
	path: string;
	label?: string;
	recordingImportId?: string;
}

export interface DocumentServiceOptions {
	/**
	 * Called only after a project is readable from disk. Derived-media services
	 * can schedule work here without delaying or weakening the project save.
	 */
	onDocumentReady?: (document: AxcutDocument) => void | Promise<void>;
}

export class DocumentNotFoundError extends Error {
	constructor(public readonly projectId: string) {
		super(`Project not found: ${projectId}`);
		this.name = "DocumentNotFoundError";
	}
}

export class ProjectFileError extends Error {
	constructor(
		message: string,
		public readonly projectId?: string,
	) {
		super(message);
		this.name = "ProjectFileError";
	}
}

const SUPPORTED_VIDEO_EXTENSIONS = new Set([
	".mp4",
	".mov",
	".m4v",
	".webm",
	".mkv",
	".avi",
	".wmv",
]);

function isSupportedVideoPath(filePath: string): boolean {
	const ext = path.extname(filePath).toLowerCase();
	return SUPPORTED_VIDEO_EXTENSIONS.has(ext);
}

function safeProjectId(raw: string): string {
	// ponytail: project ids are uuid-prefixed strings (e.g. "proj_<uuid>"). Reject
	// anything that smells like path traversal before we ever touch the disk.
	if (!/^[A-Za-z0-9_-]+$/.test(raw)) {
		throw new ProjectFileError(`Invalid project id: ${raw}`);
	}
	return raw;
}

// ponytail: load-time migration hook. The on-disk file may carry any supported
// `schemaVersion` (v2 EditorProjectData handled separately by
// `migrateProjectDataToAxcutDocument`; v3 / v4 AxcutDocuments handled here).
// `documentSchema.parse` is now a pure v6 validator — every JSON-read path
// (list, get, future bulk-export) must run the upgrader chain first via this
// helper so the in-memory parse is a single `z.literal(6)` + shape check.
// `getProject` spells the same two steps out inline because it relinks moved
// media between them; keep the order (upgrade, then validate) in step.
function parseLoadedDocument(raw: string): AxcutDocument {
	return documentSchema.parse(migrateRawDocumentToCurrent(JSON.parse(raw)));
}

/**
 * Windows fails a rename onto an open file with EPERM/EBUSY: an indexer, an
 * antivirus or a backup agent can hold the destination for a few milliseconds
 * after we last touched it. The write itself is sound, so retry briefly rather
 * than surface a save error the user cannot act on. POSIX renames don't hit this
 * and take the first attempt.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
	const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
	for (let attempt = 0; ; attempt++) {
		try {
			await fs.rename(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException)?.code ?? "";
			if (attempt >= 5 || !RETRYABLE.has(code)) throw error;
			await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt));
		}
	}
}

async function writeFileAtomically(
	filePath: string,
	contents: string,
	createOnly = false,
): Promise<void> {
	const tempPath = `${filePath}.tmp-${process.pid}-${createId("w")}`;
	let handle: FileHandle | undefined;
	try {
		handle = await fs.open(tempPath, "w");
		await handle.writeFile(contents, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		if (createOnly) {
			// Publish a complete compatibility copy only if still absent. Another
			// service may already have created or adopted the canonical project.
			await fs.link(tempPath, filePath);
			await fs.unlink(tempPath);
		} else {
			await renameWithRetry(tempPath, filePath);
		}
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.unlink(tempPath).catch(() => undefined);
		throw error;
	}
}

export class DocumentService {
	private readonly projectsRoot: string;
	private readonly mediaRegistryDir: string;
	private legacyMigration: Promise<void> | null = null;
	/** Tail of the in-flight save chain per project id — see writeProject. */
	private static readonly writeQueues = new Map<string, Promise<unknown>>();

	// `mediaRegistryDir` is where the media-links registry file lives
	// (RECORDINGS_DIR in production) — see getProject. Injected for the same
	// reason as `projectsRoot`: this module stays free of any `electron` import.
	constructor(
		projectsRoot: string,
		mediaRegistryDir: string,
		private readonly options: DocumentServiceOptions = {},
	) {
		this.projectsRoot = projectsRoot;
		this.mediaRegistryDir = mediaRegistryDir;
	}

	private notifyDocumentReady(document: AxcutDocument): void {
		try {
			void Promise.resolve(this.options.onDocumentReady?.(document)).catch((error) => {
				console.warn("[ai-edition] post-save media scheduling failed:", error);
			});
		} catch (error) {
			console.warn("[ai-edition] post-save media scheduling failed:", error);
		}
	}

	async ensureProjectsDir(): Promise<void> {
		await fs.mkdir(this.projectsRoot, { recursive: true });
		await this.migrateLegacyExtensions();
	}

	// One-time-per-process compatibility pass. A legacy file stays in place as a
	// rollback copy. Klippt validates and copies it to the canonical extension,
	// then all future writes target only the `.klippt` file.
	private migrateLegacyExtensions(): Promise<void> {
		this.legacyMigration ??= this.copyLegacyProjectsToCanonicalExtension();
		return this.legacyMigration;
	}

	private async copyLegacyProjectsToCanonicalExtension(): Promise<void> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.projectsRoot);
		} catch {
			return;
		}
		for (const suffix of LEGACY_PROJECT_FILE_SUFFIXES) {
			for (const name of entries.filter((entry) => entry.toLowerCase().endsWith(suffix))) {
				const from = path.join(this.projectsRoot, name);
				const base = name.slice(0, -suffix.length);
				const to = path.join(this.projectsRoot, `${base}${CANONICAL_PROJECT_FILE_EXTENSION}`);
				try {
					await fs.access(to);
					continue;
				} catch {
					// No canonical project exists yet.
				}
				try {
					const raw = await fs.readFile(from, "utf8");
					const record = parseProjectTransactionRecord(raw);
					// Preserve receipts when copying a transaction-aware legacy filename.
					await writeFileAtomically(
						to,
						record.metadata ? raw : JSON.stringify(record.document, null, 2),
						true,
					);
				} catch (error) {
					console.warn(`[ai-edition] failed to copy legacy project ${from} -> ${to}:`, error);
				}
			}
		}
	}

	private fileFor(projectId: string): string {
		const safe = safeProjectId(projectId);
		return path.join(this.projectsRoot, `${safe}${CANONICAL_PROJECT_FILE_EXTENSION}`);
	}

	private legacyFileFor(projectId: string, suffix: string): string {
		const safe = safeProjectId(projectId);
		return path.join(this.projectsRoot, `${safe}${suffix}`);
	}

	async listProjects(): Promise<ProjectSummary[]> {
		await this.ensureProjectsDir();
		const entries = await fs.readdir(this.projectsRoot);
		const projectFiles = entries.filter((name) => name.endsWith(CANONICAL_PROJECT_FILE_EXTENSION));
		const summaries: ProjectSummary[] = [];
		for (const name of projectFiles) {
			const filePath = path.join(this.projectsRoot, name);
			try {
				const raw = await fs.readFile(filePath, "utf8");
				const parsed = parseLoadedDocument(raw);
				summaries.push({
					id: parsed.project.id,
					title: parsed.project.title,
					updatedAt: parsed.project.updatedAt,
					assetCount: parsed.assets.length,
				});
			} catch (error) {
				// ponytail: skip unreadable files rather than failing the whole list.
				// A future migration pass can recover them.
				console.warn(`[ai-edition] failed to read ${filePath}:`, error);
			}
		}
		summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return summaries;
	}

	async getProject(projectId: string): Promise<AxcutDocument> {
		return (await this.getProjectView(projectId)).document;
	}
	/** Resolve media and expose transaction identity from the same raw file read. */
	async getProjectView(projectId: string): Promise<{
		document: AxcutDocument;
		transactionVersion?: ProjectTransactionVersion;
		undoRecovery?: ProjectTransactionSnapshot["undoRecovery"];
	}> {
		await this.ensureProjectsDir();
		const candidates = [
			this.fileFor(projectId),
			...LEGACY_PROJECT_FILE_SUFFIXES.map((suffix) => this.legacyFileFor(projectId, suffix)),
		];
		let raw: string | undefined;
		for (const candidate of candidates) {
			try {
				raw = await fs.readFile(candidate, "utf8");
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
					throw new ProjectFileError(
						`Failed to read project ${projectId}: ${error instanceof Error ? error.message : String(error)}`,
						projectId,
					);
				}
			}
		}
		if (raw === undefined) throw new DocumentNotFoundError(projectId);
		// Relink here rather than in the .openscreen import handlers, because this
		// is the one place every open funnels through — the project picker, the
		// agent, and the auto-load-last-project effect on launch. A document whose
		// media moved (or that was authored on another machine, issue #212) is
		// otherwise re-read as broken on every subsequent open, and media that
		// moves after the import is never noticed at all. The relink is applied to
		// the upgraded JSON so `documentSchema.parse` still validates what we hand
		// back, and it is not persisted from here: the renderer saves the document
		// it was given, as it does for any other load-time repair.
		const record = parseProjectTransactionRecord(raw);
		if (record.document.project.id !== projectId)
			throw new ProjectFileError("Project identity does not match managed path", projectId);
		const migrated = migrateRawDocumentToCurrent(JSON.parse(raw));
		const document = documentSchema.parse(
			await relinkProjectMedia(migrated, this.mediaRegistryDir),
		);
		this.notifyDocumentReady(document);
		return {
			document,
			...(record.metadata
				? { transactionVersion: record.version, undoRecovery: record.undoRecovery }
				: {}),
		};
	}

	async createProject(title: string): Promise<AxcutDocument> {
		await this.ensureProjectsDir();
		const projectId = createId("proj");
		const doc = createEmptyDocument({
			projectId,
			title: title?.trim() || "Untitled Project",
		});
		await this.writeProject(doc);
		return doc;
	}

	async saveProject(document: AxcutDocument): Promise<AxcutDocument> {
		const parsed = documentSchema.parse(document);
		const stamped: AxcutDocument = {
			...parsed,
			project: { ...parsed.project, updatedAt: new Date().toISOString() },
		};
		await this.writeProject(stamped);
		return stamped;
	}

	async deleteProject(projectId: string): Promise<void> {
		return this.enqueueProject(projectId, async () => {
			await this.assertUnconditionalWriteAllowed(projectId);
			for (const filePath of [
				this.fileFor(projectId),
				...LEGACY_PROJECT_FILE_SUFFIXES.map((suffix) => this.legacyFileFor(projectId, suffix)),
			]) {
				try {
					await fs.unlink(filePath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
						throw error;
					}
				}
			}
		});
	}

	/** Unrelinked, validated persisted content plus exact on-disk version. Media
	 * resolution remains the separate getProject view; never hash that repaired view.
	 */
	async getTransactionSnapshot(projectId: string): Promise<ProjectTransactionSnapshot> {
		return this.enqueueProject(projectId, async () => {
			await this.ensureProjectsDir();
			const snapshot = await new ProjectTransactionStore(this.fileFor(projectId)).read();
			if (snapshot.document.project.id !== projectId)
				throw new ProjectFileError("Project identity does not match its managed path", projectId);
			return snapshot;
		});
	}

	/** Additive internal API only. External editing remains disabled until every
	 * GUI writer, ownership lease and Undo acknowledgement uses this authority.
	 */
	async commitTransaction(
		projectId: string,
		request: {
			requestId: string;
			payload: unknown;
			expected: ProjectTransactionVersion;
			recordUndo?: boolean;
			agentHistory?: AgentHistoryIntent;
		},
		transform: (document: AxcutDocument) => AxcutDocument,
	): Promise<ProjectTransactionReceipt> {
		return this.enqueueProject(projectId, async () => {
			await this.ensureProjectsDir();
			const store = new ProjectTransactionStore(this.fileFor(projectId));
			if ((await store.read()).document.project.id !== projectId)
				throw new ProjectFileError("Project identity does not match its managed path", projectId);
			let committedDocument: AxcutDocument | undefined;
			const receipt = await store.commit(request, (document) => {
				const next = transform(document);
				committedDocument = documentSchema.parse({
					...next,
					project: { ...next.project, updatedAt: new Date().toISOString() },
				});
				return committedDocument;
			});
			if (committedDocument) this.notifyDocumentReady(committedDocument);
			return receipt;
		});
	}

	async getAgentHistory(projectId: string) {
		return this.enqueueProject(projectId, async () => {
			const store = new ProjectTransactionStore(this.fileFor(projectId));
			if ((await store.read()).document.project.id !== projectId)
				throw new ProjectFileError("Project identity mismatch", projectId);
			return (await store.history()).list();
		});
	}
	async prepareAgentRestore(
		projectId: string,
		kind: "undo" | "redo",
		input: { steps?: number; to?: string; force?: boolean },
	) {
		return this.enqueueProject(projectId, async () => {
			const store = new ProjectTransactionStore(this.fileFor(projectId));
			const snapshot = await store.read();
			if (snapshot.document.project.id !== projectId)
				throw new ProjectFileError("Project identity mismatch", projectId);
			return {
				...(await (await store.history()).select(kind, snapshot.version, input)),
				version: snapshot.version,
				before: snapshot.document,
			};
		});
	}

	async getTransactionReceipt(
		projectId: string,
		requestId: string,
	): Promise<ProjectTransactionReceipt | null> {
		return this.enqueueProject(projectId, async () => {
			await this.ensureProjectsDir();
			const store = new ProjectTransactionStore(this.fileFor(projectId));
			if ((await store.read()).document.project.id !== projectId)
				throw new ProjectFileError("Project identity does not match its managed path", projectId);
			return store.receipt(requestId);
		});
	}

	private async assertUnconditionalWriteAllowed(projectId: string): Promise<void> {
		let raw: string;
		try {
			raw = await fs.readFile(this.fileFor(projectId), "utf8");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const value: unknown = JSON.parse(raw);
		if (value && typeof value === "object" && "_klipptTransactions" in value) {
			throw new ProjectFileError(
				"Revision-aware project requires a guarded transaction; unconditional write refused",
				projectId,
			);
		}
	}

	/** Prepare a complete file reference without changing any project revision. */
	async prepareAsset(projectId: string, input: AddAssetInput): Promise<AxcutAsset> {
		await this.getTransactionSnapshot(projectId);
		if (!input.path || !isSupportedVideoPath(input.path))
			throw new ProjectFileError("A supported video file is required.", projectId);
		const originalPath = path.resolve(input.path);
		const handle = await fs.open(originalPath, "r");
		try {
			const stats = await handle.stat();
			if (!stats.isFile() || stats.size === 0)
				throw new ProjectFileError("The video file must be complete and nonempty.", projectId);
			// Node 22 FileHandle.sync flushes this existing source before a document
			// can reference it. This does not copy or take ownership of user media.
			await handle.sync();
			return {
				id: createId("asset"),
				kind: "video",
				label: input.label?.trim() || path.basename(originalPath),
				originalPath,
				sizeBytes: stats.size,
				cameraTrack: null,
				...(input.recordingImportId ? { recordingImportId: input.recordingImportId } : {}),
			};
		} finally {
			await handle.close();
		}
	}

	/** Import is a new project, never an unconditional replacement of another ID. */
	async importProject(document: unknown): Promise<AxcutDocument> {
		const parsed = documentSchema.parse(document);
		const now = new Date().toISOString();
		const copy: AxcutDocument = {
			...parsed,
			project: { ...parsed.project, id: createId("proj"), createdAt: now, updatedAt: now },
		};
		await this.ensureProjectsDir();
		await this.enqueueProject(copy.project.id, async () => {
			await writeFileAtomically(this.fileFor(copy.project.id), JSON.stringify(copy, null, 2), true);
			this.notifyDocumentReady(copy);
		});
		return copy;
	}

	async addAsset(projectId: string, input: AddAssetInput): Promise<AxcutDocument> {
		const doc = await this.getProject(projectId);
		if (!input.path) {
			throw new ProjectFileError("Asset path is required.", projectId);
		}
		if (!isSupportedVideoPath(input.path)) {
			throw new ProjectFileError(
				`Unsupported video extension: ${path.extname(input.path)} (supported: ${[...SUPPORTED_VIDEO_EXTENSIONS].join(", ")})`,
				projectId,
			);
		}
		const absolutePath = path.isAbsolute(input.path) ? input.path : path.resolve(input.path);
		// P3.1 — capture the file size at import. Non-fatal: a stat failure
		// (network drive, permissions) just leaves sizeBytes undefined.
		let sizeBytes: number | undefined;
		try {
			sizeBytes = (await fs.stat(absolutePath)).size;
		} catch {
			sizeBytes = undefined;
		}
		const asset: AxcutAsset = {
			id: createId("asset"),
			kind: "video",
			label: input.label?.trim() || path.basename(absolutePath),
			originalPath: absolutePath,
			...(input.recordingImportId ? { recordingImportId: input.recordingImportId } : {}),
			sizeBytes,
			cameraTrack: null,
		};
		const next: AxcutDocument = {
			...doc,
			assets: [...doc.assets, asset],
			project: {
				...doc.project,
				...(doc.project.primaryAssetId ? {} : { primaryAssetId: asset.id }),
				updatedAt: new Date().toISOString(),
			},
		};
		return this.saveProject(next);
	}

	async removeAsset(projectId: string, assetId: string): Promise<AxcutDocument> {
		const doc = await this.getProject(projectId);
		if (!doc.assets.some((a) => a.id === assetId)) {
			throw new ProjectFileError(`Asset ${assetId} not found in project ${projectId}.`, projectId);
		}
		const next = removeAssetFromDocument(doc, assetId);
		return this.saveProject(next);
	}

	/**
	 * Serialise saves per project, then write atomically.
	 *
	 * This has destroyed real project files. `fs.writeFile` opens with O_TRUNC and
	 * writes from offset 0, so two concurrent saves of the SAME project interleave
	 * onto one path: the short document lands over the long one's opening bytes and
	 * the long one's tail survives past its end. The result parses as JSON right up
	 * to the splice and then dies — the file is unreadable and the edits in it are
	 * gone. Two projects on this machine were lost exactly that way (a complete
	 * document followed by the tail of a longer, older version).
	 *
	 * Both halves are load-bearing:
	 *  - the queue makes concurrent saves of one project sequential, so a save
	 *    always writes over a settled file, never a half-written one;
	 *  - temp + rename makes each save all-or-nothing, so a crash (or a full disk)
	 *    mid-write leaves the previous document intact instead of a truncated one.
	 * The queue alone would still leave a torn file on a crash; the rename alone
	 * would still let two saves race for the same destination.
	 */
	private enqueueProject<T>(projectId: string, work: () => Promise<T>): Promise<T> {
		const key = this.fileFor(projectId);
		const tail = DocumentService.writeQueues.get(key) ?? Promise.resolve();
		const run = tail.catch(() => undefined).then(work);
		DocumentService.writeQueues.set(key, run);
		void run
			.finally(() => {
				if (DocumentService.writeQueues.get(key) === run) DocumentService.writeQueues.delete(key);
			})
			.catch(() => undefined);
		return run;
	}

	private writeProject(doc: AxcutDocument): Promise<void> {
		return this.enqueueProject(doc.project.id, () => this.writeProjectNow(doc));
	}

	private async writeProjectNow(doc: AxcutDocument): Promise<void> {
		await this.ensureProjectsDir();
		const filePath = this.fileFor(doc.project.id);
		await this.assertUnconditionalWriteAllowed(doc.project.id);
		// The suffix goes AFTER the extension on purpose: listProjects matches on a
		// trailing `.klippt`, so an interrupted write's leftover is invisible to
		// it rather than showing up as a corrupt project. Unique per write, so two
		// queues (or two processes) never share a temp path.
		const json = JSON.stringify(doc, null, 2);
		try {
			await writeFileAtomically(filePath, json);
			this.notifyDocumentReady(doc);
		} catch (error) {
			throw new ProjectFileError(
				`Failed to save project ${doc.project.id}: ${error instanceof Error ? error.message : String(error)}`,
				doc.project.id,
			);
		}
	}
}
