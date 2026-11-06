import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveFinalSymlink } from "../filesystem/durableJson";
import { PublicationLifecycle } from "./publicationLifecycle";

const JOURNAL_VERSION = 2;
const STAGING_MARKER = ".klippt-export-";
const DEFAULT_SAFETY_BYTES = 256n * 1024n * 1024n;
const MINIMUM_SAFETY_BYTES = 64n * 1024n * 1024n;

export type ExportTransactionPhase =
	| "preflight"
	| "rendering"
	| "verification"
	| "syncing"
	| "publishing"
	| "cleanup";

export type ExportTransactionErrorCode =
	| "CANCELLED"
	| "INSUFFICIENT_SPACE"
	| "PREFLIGHT_FAILED"
	| "RENDER_FAILED"
	| "VERIFICATION_FAILED"
	| "SYNC_FAILED"
	| "PUBLISH_FAILED"
	| "CLEANUP_FAILED";

export interface ExportTransactionWarning {
	phase: "publishing";
	code: "DURABILITY_UNCONFIRMED";
	message: string;
	retryable: false;
}

export class ExportTransactionError extends Error {
	constructor(
		message: string,
		readonly phase: ExportTransactionPhase,
		readonly code: ExportTransactionErrorCode,
		readonly retryable = false,
		readonly cause?: Error,
	) {
		super(message);
		this.name = "ExportTransactionError";
	}
}

interface JournalEntry {
	stagingPath: string;
	finalPath: string;
	startedAt: string;
}

interface ExportJournal {
	version: typeof JOURNAL_VERSION;
	ownerPid: number;
	ownerToken: string;
	entries: JournalEntry[];
}

interface LegacyExportJournal {
	version: 1;
	entries: JournalEntry[];
}

export interface AtomicExportRequest<T> {
	finalPath: string;
	expectedBytes: number;
	signal?: AbortSignal;
	render: (stagingPath: string, signal: AbortSignal) => Promise<T>;
	verify: (stagingPath: string, result: T, signal: AbortSignal) => Promise<void>;
	onPhase?: (phase: ExportTransactionPhase) => void;
	onWarning?: (warning: ExportTransactionWarning) => void;
}

export interface AtomicExportPublisherOptions {
	journalPath: string;
	capacityCheckIntervalMs?: number;
	safetyBytes?: bigint;
	getAvailableBytes?: (directoryPath: string) => Promise<bigint>;
	syncFile?: (filePath: string) => Promise<void>;
	syncDirectory?: (directoryPath: string) => Promise<void>;
	renameFile?: (from: string, to: string) => Promise<void>;
	removeStagingFile?: (stagingPath: string) => Promise<void>;
	isProcessAlive?: (pid: number) => boolean;
}

function isJournalEntry(value: unknown): value is JournalEntry {
	if (!value || typeof value !== "object") return false;
	const entry = value as Partial<JournalEntry>;
	return (
		typeof entry.stagingPath === "string" &&
		path.isAbsolute(entry.stagingPath) &&
		path.basename(entry.stagingPath).includes(STAGING_MARKER) &&
		typeof entry.finalPath === "string" &&
		path.isAbsolute(entry.finalPath) &&
		path.dirname(entry.stagingPath) === path.dirname(entry.finalPath) &&
		typeof entry.startedAt === "string"
	);
}

function parseJournal(value: unknown): ExportJournal | null {
	if (!value || typeof value !== "object") return null;
	const journal = value as Partial<ExportJournal>;
	if (
		journal.version !== JOURNAL_VERSION ||
		!Number.isSafeInteger(journal.ownerPid) ||
		(journal.ownerPid ?? 0) <= 0 ||
		typeof journal.ownerToken !== "string" ||
		!journal.ownerToken ||
		!Array.isArray(journal.entries)
	) {
		return null;
	}
	if (!journal.entries.every(isJournalEntry)) return null;
	return journal as ExportJournal;
}

function parseLegacyJournal(value: unknown): LegacyExportJournal | null {
	if (!value || typeof value !== "object") return null;
	const journal = value as Partial<LegacyExportJournal>;
	if (journal.version !== 1 || !Array.isArray(journal.entries)) return null;
	if (!journal.entries.every(isJournalEntry)) return null;
	return journal as LegacyExportJournal;
}

function defaultIsProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function stagingOwnerPid(stagingPath: string): number | null {
	const match = path.basename(stagingPath).match(/\.klippt-export-(\d+)-[0-9a-f-]+(?=\.[^.]+$|$)/i);
	if (!match) return null;
	const pid = Number(match[1]);
	return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function stagingPathFor(finalPath: string): string {
	const extension = path.extname(finalPath);
	const stem = path.basename(finalPath, extension);
	return path.join(
		path.dirname(finalPath),
		`.${stem}${STAGING_MARKER}${process.pid}-${randomUUID()}${extension}`,
	);
}

async function syncDirectory(directoryPath: string): Promise<void> {
	if (process.platform === "win32") return;
	const handle = await fs.open(directoryPath, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isUnsupportedDirectorySync(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS" || code === "EBADF";
}

async function renameWithRetry(
	from: string,
	to: string,
	signal: AbortSignal,
	renameFile: (from: string, to: string) => Promise<void> = fs.rename,
): Promise<void> {
	const retryable = new Set(["EPERM", "EACCES", "EBUSY"]);
	for (let attempt = 0; ; attempt += 1) {
		throwIfAborted(signal, "publishing");
		try {
			await renameFile(from, to);
			return;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code ?? "";
			if (attempt >= 5 || !retryable.has(code)) throw error;
			await new Promise<void>((resolve, reject) => {
				const abort = () => {
					clearTimeout(timeout);
					signal.removeEventListener("abort", abort);
					reject(new ExportTransactionError("Export cancelled.", "publishing", "CANCELLED"));
				};
				const timeout = setTimeout(
					() => {
						signal.removeEventListener("abort", abort);
						resolve();
					},
					10 * 2 ** attempt,
				);
				if (signal.aborted) abort();
				else signal.addEventListener("abort", abort, { once: true });
				timeout.unref?.();
			});
		}
	}
}

async function writeJournalAtomically(
	journalPath: string,
	journal: ExportJournal | null,
): Promise<void> {
	const directory = path.dirname(journalPath);
	await fs.mkdir(directory, { recursive: true });
	if (!journal || journal.entries.length === 0) {
		await fs.rm(journalPath, { force: true });
		await syncDirectory(directory);
		return;
	}

	const temporaryPath = path.join(
		directory,
		`.${path.basename(journalPath)}.${process.pid}.${randomUUID()}.tmp`,
	);
	let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
	try {
		handle = await fs.open(temporaryPath, "wx", 0o600);
		await handle.writeFile(`${JSON.stringify(journal, null, 2)}\n`, "utf8");
		await handle.sync();
		await handle.close();
		handle = null;
		await fs.rename(temporaryPath, journalPath);
		await syncDirectory(directory);
	} catch (error) {
		await handle?.close().catch(() => undefined);
		await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

export function formatGigabytes(bytes: bigint): string {
	const gigabytes = Number(bytes) / 1_000_000_000;
	return `${gigabytes < 10 ? gigabytes.toFixed(1) : Math.round(gigabytes)} GB`;
}

export function availableBytes(stats: Awaited<ReturnType<typeof fs.statfs>>): bigint {
	return BigInt(stats.bavail) * BigInt(stats.bsize);
}

function asError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}

function throwIfAborted(signal: AbortSignal, phase: ExportTransactionPhase): void {
	if (signal.aborted) {
		throw new ExportTransactionError("Export cancelled.", phase, "CANCELLED");
	}
}

function wrapPhaseError(
	error: unknown,
	phase: ExportTransactionPhase,
	code: ExportTransactionErrorCode,
): ExportTransactionError {
	if (error instanceof ExportTransactionError) return error;
	const cause = asError(error);
	const filesystemCode = (error as NodeJS.ErrnoException | undefined)?.code;
	// FFmpeg's native compositor reports errno as a numeric return value. Only
	// file I/O contexts qualify: the same number from a device/decoder is not disk capacity.
	const nativeIoCode = Number(
		/\b(?:av_)?(?:interleaved_write_frame|write_trailer|avio_open|avio_close)\b[^\n]*?(?:\bret=|:\s*)(-\d+)\b/.exec(
			cause.message,
		)?.[1],
	);
	if (
		filesystemCode === "ENOSPC" ||
		filesystemCode === "EDQUOT" ||
		nativeIoCode === -28 ||
		nativeIoCode === -122 ||
		nativeIoCode === -69 ||
		/(?:^|[:(])\s*(?:No space left on device|Disk quota exceeded)(?:[).\s]|$)/i.test(cause.message)
	) {
		return new ExportTransactionError(
			"Not enough free space to finish this export safely.",
			phase,
			"INSUFFICIENT_SPACE",
			true,
			cause,
		);
	}
	if (
		filesystemCode === "EROFS" ||
		nativeIoCode === -30 ||
		/(?:^|[:(])\s*Read-only file system(?:[).\s]|$)/i.test(cause.message)
	) {
		return new ExportTransactionError(
			"This destination is read-only. Choose a writable folder.",
			phase,
			code,
			false,
			cause,
		);
	}

	if (
		filesystemCode === "EACCES" ||
		filesystemCode === "EPERM" ||
		nativeIoCode === -13 ||
		nativeIoCode === -1
	) {
		return new ExportTransactionError(
			"Permission denied for an export file. Check the source files and choose a writable destination.",
			phase,
			code,
			false,
			cause,
		);
	}
	return new ExportTransactionError(cause.message, phase, code, false, cause);
}

/**
 * Publishes exports as one durable file transaction.
 *
 * The renderer writes only to a unique sibling file. The old destination stays
 * untouched until render, validation, and fsync finish. The final rename is the
 * only operation that makes the new export visible at its requested path.
 */
export class AtomicExportPublisher {
	private readonly entries = new Map<string, JournalEntry>();
	private readonly ownerToken = randomUUID();
	private readonly ownedJournalPath: string;
	private recoveryState:
		| { kind: "uninitialized" }
		| { kind: "recovering" | "ready" | "failed"; promise: Promise<void> } = {
		kind: "uninitialized",
	};
	private journalTail = Promise.resolve();

	constructor(private readonly options: AtomicExportPublisherOptions) {
		this.ownedJournalPath = `${options.journalPath}.owner-${process.pid}-${this.ownerToken}`;
	}

	initialize(): Promise<void> {
		if (this.recoveryState.kind !== "uninitialized") return this.recoveryState.promise;
		const promise = this.recover();
		this.transitionRecovery({ type: "begin", promise });
		void promise.then(
			() => this.transitionRecovery({ type: "ready", promise }),
			() => this.transitionRecovery({ type: "failed", promise }),
		);
		return promise;
	}
	private transitionRecovery(event: {
		type: "begin" | "ready" | "failed";
		promise: Promise<void>;
	}): boolean {
		const state = this.recoveryState;
		if (
			event.type === "begin"
				? state.kind !== "uninitialized"
				: state.kind !== "recovering" || state.promise !== event.promise
		) {
			console.warn("[export-recovery] Illegal transition", {
				state: state.kind,
				event: event.type,
			});
			return false;
		}
		this.recoveryState = {
			kind: event.type === "begin" ? "recovering" : event.type,
			promise: event.promise,
		};
		return true;
	}

	async publish<T>(request: AtomicExportRequest<T>): Promise<T> {
		const requestedPath = path.normalize(request.finalPath);
		if (!path.isAbsolute(requestedPath)) {
			throw new ExportTransactionError(
				"Export destination must be an absolute path.",
				"preflight",
				"PREFLIGHT_FAILED",
			);
		}
		if (!Number.isFinite(request.expectedBytes) || request.expectedBytes <= 0) {
			throw new ExportTransactionError(
				"Export size estimate must be a finite positive number.",
				"preflight",
				"PREFLIGHT_FAILED",
			);
		}
		try {
			await this.initialize();
		} catch (error) {
			throw wrapPhaseError(error, "preflight", "PREFLIGHT_FAILED");
		}

		let finalPath: string;
		try {
			finalPath = await resolveFinalSymlink(requestedPath);
			await fs.mkdir(path.dirname(finalPath), { recursive: true });
		} catch (error) {
			throw wrapPhaseError(error, "preflight", "PREFLIGHT_FAILED");
		}

		const directory = path.dirname(finalPath);
		const stagingPath = stagingPathFor(finalPath);
		const controller = new AbortController();
		const abort = () => controller.abort(request.signal?.reason);
		if (request.signal?.aborted) {
			abort();
		} else {
			request.signal?.addEventListener("abort", abort, { once: true });
		}
		const lifecycle = new PublicationLifecycle<T>();
		const phase = (phase: ExportTransactionPhase) => {
			if (!lifecycle.transition({ type: "phase", phase }))
				throw new Error(`Illegal export phase: ${phase}`);
			request.onPhase?.(phase);
		};

		try {
			phase("preflight");
			throwIfAborted(controller.signal, "preflight");
			try {
				await this.assertCapacity(directory, stagingPath, request.expectedBytes);
				await this.addEntry({ stagingPath, finalPath, startedAt: new Date().toISOString() });
			} catch (error) {
				throw wrapPhaseError(error, "preflight", "PREFLIGHT_FAILED");
			}

			const checkCapacity = () => {
				if (!lifecycle.canCheck || controller.signal.aborted) return;
				const task = (async () => {
					try {
						await this.assertCapacity(directory, stagingPath, request.expectedBytes);
					} catch (error) {
						if (!lifecycle.monitoring) return;
						const cause = asError(error);
						const failure = new ExportTransactionError(
							cause.message,
							"rendering",
							"INSUFFICIENT_SPACE",
							true,
							cause,
						);
						if (lifecycle.transition({ type: "capacity-failed", error: failure }))
							controller.abort(failure);
					}
				})().finally(() => {
					lifecycle.transition({ type: "checked", task });
				});
				lifecycle.transition({ type: "check", task });
			};
			const capacityTimer = setInterval(
				checkCapacity,
				this.options.capacityCheckIntervalMs ?? 2_000,
			);
			capacityTimer.unref?.();
			if (!lifecycle.transition({ type: "render", timer: capacityTimer })) {
				clearInterval(capacityTimer);
				throw new Error("Illegal render start");
			}

			phase("rendering");
			let result: T;
			try {
				result = await request.render(stagingPath, controller.signal);
			} catch (error) {
				if (lifecycle.capacityFailure) throw lifecycle.capacityFailure;
				if (controller.signal.aborted) {
					throw new ExportTransactionError("Export cancelled.", "rendering", "CANCELLED");
				}
				throw wrapPhaseError(error, "rendering", "RENDER_FAILED");
			}
			if (lifecycle.capacityFailure) throw lifecycle.capacityFailure;
			throwIfAborted(controller.signal, "rendering");
			lifecycle.transition({ type: "rendered" });
			await lifecycle.capacityTask;
			if (lifecycle.capacityFailure) throw lifecycle.capacityFailure;

			phase("verification");
			try {
				await request.verify(stagingPath, result, controller.signal);
			} catch (error) {
				if (controller.signal.aborted) {
					throw new ExportTransactionError("Export cancelled.", "verification", "CANCELLED");
				}
				throw wrapPhaseError(error, "verification", "VERIFICATION_FAILED");
			}
			throwIfAborted(controller.signal, "verification");

			phase("syncing");
			try {
				if (this.options.syncFile) {
					await this.options.syncFile(stagingPath);
				} else {
					const handle = await fs.open(stagingPath, "r");
					try {
						await handle.sync();
					} finally {
						await handle.close();
					}
				}
			} catch (error) {
				throw wrapPhaseError(error, "syncing", "SYNC_FAILED");
			}
			throwIfAborted(controller.signal, "syncing");

			phase("publishing");
			try {
				throwIfAborted(controller.signal, "publishing");
				await renameWithRetry(stagingPath, finalPath, controller.signal, this.options.renameFile);
			} catch (error) {
				throw wrapPhaseError(error, "publishing", "PUBLISH_FAILED");
			}
			lifecycle.transition({ type: "committed", result });
			// The rename is the commit point. A valid final file is already visible,
			// so a directory-fsync failure cannot safely roll back or report the export
			// as absent. Ignore only filesystems that do not support directory sync.
			// Report all other failures as a structured committed-but-unconfirmed warning.
			try {
				await (this.options.syncDirectory?.(directory) ?? syncDirectory(directory));
			} catch (error) {
				if (!isUnsupportedDirectorySync(error)) {
					request.onWarning?.({
						phase: "publishing",
						code: "DURABILITY_UNCONFIRMED",
						message:
							"The export was saved, but the storage device did not confirm the final directory update.",
						retryable: false,
					});
				}
			}
			// Publication already succeeded. A stale recovery entry is safe because
			// recovery removes the sibling staging path, which no longer exists, and
			// then clears the journal. Do not turn a committed export into a reported
			// failure only because this bookkeeping write failed.
			await this.removeEntry(stagingPath).catch((error) => {
				console.warn("[export] failed to clear committed export recovery entry:", error);
			});
			lifecycle.transition({ type: "done" });
			return result;
		} catch (error) {
			const committed = lifecycle.committed;
			if (committed) {
				console.warn("[export] post-publication notification failed:", error);
				return committed.result;
			}
			phase("cleanup");
			try {
				if (this.options.removeStagingFile) {
					await this.options.removeStagingFile(stagingPath);
				} else {
					await fs.rm(stagingPath, { force: true });
				}
			} catch (cleanupError) {
				const code = (cleanupError as NodeJS.ErrnoException | undefined)?.code;
				lifecycle.transition({ type: "cleanup-blocked" });
				const blocked = code === "EACCES" || code === "EPERM" || code === "EROFS";
				throw new ExportTransactionError(
					blocked
						? "Export was not saved. Klippt cannot remove its partial file; restore write access to the destination folder."
						: "Export failed and its partial file could not be removed safely.",
					"cleanup",
					"CLEANUP_FAILED",
					true,
					asError(cleanupError),
				);
			}
			await this.removeEntry(stagingPath).catch((cleanupError) => {
				console.warn("[export] failed to clear export recovery journal:", cleanupError);
			});
			lifecycle.transition({ type: "failed" });
			throw error;
		} finally {
			request.signal?.removeEventListener("abort", abort);
		}
	}

	private async assertCapacity(
		directory: string,
		stagingPath: string,
		expectedBytes: number,
	): Promise<void> {
		const expected = BigInt(Math.max(0, Math.ceil(expectedBytes)));
		const written = BigInt((await fs.stat(stagingPath).catch(() => null))?.size ?? 0);
		const remaining = expected > written ? expected - written : 0n;
		const configuredSafety = this.options.safetyBytes ?? DEFAULT_SAFETY_BYTES;
		const proportionalSafety = expected / 10n;
		const safety = [MINIMUM_SAFETY_BYTES, configuredSafety, proportionalSafety].reduce((a, b) =>
			a > b ? a : b,
		);
		const free = this.options.getAvailableBytes
			? await this.options.getAvailableBytes(directory)
			: availableBytes(await fs.statfs(directory));
		if (free < remaining + safety) {
			throw new ExportTransactionError(
				`Not enough free space to finish this export safely. It needs about ${formatGigabytes(remaining + safety)} free, and this disk has ${formatGigabytes(free)}.`,
				"preflight",
				"INSUFFICIENT_SPACE",
				true,
			);
		}
	}

	private async recover(): Promise<void> {
		const directory = path.dirname(this.options.journalPath);
		const baseName = path.basename(this.options.journalPath);
		const ownerPattern = new RegExp(
			`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.owner-(\\d+)-([0-9a-f-]+)$`,
			"i",
		);
		const candidates = await fs.readdir(directory).catch((error) => {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		});
		const isProcessAlive = this.options.isProcessAlive ?? defaultIsProcessAlive;

		for (const name of candidates) {
			const ownerMatch = name.match(ownerPattern);
			if (name !== baseName && !ownerMatch) continue;
			const journalPath = path.join(directory, name);
			const value = await fs
				.readFile(journalPath, "utf8")
				.then((raw) => JSON.parse(raw) as unknown)
				.catch(() => null);
			const parsed = parseJournal(value);
			if (parsed) {
				if (
					!ownerMatch ||
					Number(ownerMatch[1]) !== parsed.ownerPid ||
					ownerMatch[2] !== parsed.ownerToken ||
					parsed.entries.some((entry) => stagingOwnerPid(entry.stagingPath) !== parsed.ownerPid)
				) {
					continue;
				}
				if (isProcessAlive(parsed.ownerPid)) continue;
				let cleanupFailed = false;
				for (const entry of parsed.entries) {
					try {
						if (this.options.removeStagingFile) {
							await this.options.removeStagingFile(entry.stagingPath);
						} else {
							await fs.rm(entry.stagingPath, { force: true });
						}
					} catch {
						cleanupFailed = true;
					}
				}
				if (!cleanupFailed) {
					await fs.rm(journalPath, { force: true }).catch(() => undefined);
				}
				continue;
			}

			const legacy = name === baseName ? parseLegacyJournal(value) : null;
			if (!legacy) continue;
			const hasLiveOwner = legacy.entries.some((entry) => {
				const pid = stagingOwnerPid(entry.stagingPath);
				return pid !== null && isProcessAlive(pid);
			});
			if (hasLiveOwner) continue;
			let cleanupFailed = false;
			for (const entry of legacy.entries) {
				try {
					if (this.options.removeStagingFile) {
						await this.options.removeStagingFile(entry.stagingPath);
					} else {
						await fs.rm(entry.stagingPath, { force: true });
					}
				} catch {
					cleanupFailed = true;
				}
			}
			if (!cleanupFailed) {
				await fs.rm(journalPath, { force: true }).catch(() => undefined);
			}
		}
	}

	private updateJournal(update: () => void): Promise<void> {
		const run = this.journalTail.then(async () => {
			update();
			await writeJournalAtomically(
				this.ownedJournalPath,
				this.entries.size > 0
					? {
							version: JOURNAL_VERSION,
							ownerPid: process.pid,
							ownerToken: this.ownerToken,
							entries: [...this.entries.values()],
						}
					: null,
			);
		});
		this.journalTail = run.catch(() => undefined);
		return run;
	}

	private addEntry(entry: JournalEntry): Promise<void> {
		return this.updateJournal(() => this.entries.set(entry.stagingPath, entry));
	}

	private removeEntry(stagingPath: string): Promise<void> {
		return this.updateJournal(() => this.entries.delete(stagingPath));
	}
}
