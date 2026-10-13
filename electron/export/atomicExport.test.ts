import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtomicExportPublisher, ExportTransactionError } from "./atomicExport";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	return {
		promise: new Promise<void>((done) => {
			resolve = done;
		}),
		resolve: () => resolve(),
	};
}

describe("AtomicExportPublisher", () => {
	let directory: string;
	let journalPath: string;

	beforeEach(async () => {
		directory = await mkdtemp(path.join(os.tmpdir(), "klippt-export-"));
		journalPath = path.join(directory, "export-journal.json");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await rm(directory, { recursive: true, force: true });
	});

	function publisher(
		interval = 5,
		getAvailableBytes?: (directoryPath: string) => Promise<bigint>,
	): AtomicExportPublisher {
		return new AtomicExportPublisher({
			journalPath,
			capacityCheckIntervalMs: interval,
			safetyBytes: 0n,
			getAvailableBytes,
		});
	}

	it("publishes a verified sibling file and clears recovery state", async () => {
		const finalPath = path.join(directory, "video.mp4");
		let renderedPath = "";
		const phases: string[] = [];

		const result = await publisher().publish({
			finalPath,
			expectedBytes: 12,
			render: async (stagingPath) => {
				renderedPath = stagingPath;
				await writeFile(stagingPath, "verified MP4");
				return { frames: 10 };
			},
			verify: async (stagingPath) => {
				expect(await readFile(stagingPath, "utf8")).toBe("verified MP4");
			},
			onPhase: (phase) => phases.push(phase),
		});

		expect(result).toEqual({ frames: 10 });
		expect(await readFile(finalPath, "utf8")).toBe("verified MP4");
		expect(path.dirname(renderedPath)).toBe(path.dirname(finalPath));
		expect(renderedPath).not.toBe(finalPath);
		await expect(stat(renderedPath)).rejects.toThrow();
		await expect(stat(journalPath)).rejects.toThrow();
		expect(phases).toEqual(["preflight", "rendering", "verification", "syncing", "publishing"]);
	});

	it("keeps the old destination visible throughout a slow render", async () => {
		const finalPath = path.join(directory, "video.mp4");
		await writeFile(finalPath, "old export");
		const renderStarted = deferred();
		const finishRender = deferred();
		const operation = publisher().publish({
			finalPath,
			expectedBytes: 20,
			render: async (stagingPath) => {
				await writeFile(stagingPath, "partial new export");
				renderStarted.resolve();
				await finishRender.promise;
				await writeFile(stagingPath, "complete new export");
			},
			verify: async (stagingPath) => {
				expect(await readFile(stagingPath, "utf8")).toBe("complete new export");
			},
		});

		await renderStarted.promise;
		expect(await readFile(finalPath, "utf8")).toBe("old export");
		finishRender.resolve();
		await operation;
		expect(await readFile(finalPath, "utf8")).toBe("complete new export");
	});

	it("keeps the old destination visible while a slow storage sync is pending", async () => {
		const finalPath = path.join(directory, "video.mp4");
		await writeFile(finalPath, "old export");
		const syncStarted = deferred();
		const finishSync = deferred();
		const exportPublisher = new AtomicExportPublisher({
			journalPath,
			safetyBytes: 0n,
			getAvailableBytes: async () => 1024n ** 4n,
			syncFile: async () => {
				syncStarted.resolve();
				await finishSync.promise;
			},
		});
		const operation = exportPublisher.publish({
			finalPath,
			expectedBytes: 20,
			render: async (stagingPath) => writeFile(stagingPath, "complete new export"),
			verify: async () => undefined,
		});

		await syncStarted.promise;
		expect(await readFile(finalPath, "utf8")).toBe("old export");
		finishSync.resolve();
		await operation;
		expect(await readFile(finalPath, "utf8")).toBe("complete new export");
	});

	it("keeps an existing export when rendering fails", async () => {
		const finalPath = path.join(directory, "video.mp4");
		await writeFile(finalPath, "old export");

		await expect(
			publisher().publish({
				finalPath,
				expectedBytes: 20,
				render: async (stagingPath) => {
					await writeFile(stagingPath, "partial new export");
					throw new Error("encoder failed");
				},
				verify: async () => undefined,
			}),
		).rejects.toMatchObject({ phase: "rendering", code: "RENDER_FAILED" });

		expect(await readFile(finalPath, "utf8")).toBe("old export");
	});

	it("keeps recovery state when partial-file cleanup fails", async () => {
		const finalPath = path.join(directory, "video.mp4");
		await writeFile(finalPath, "old export");
		const exportPublisher = new AtomicExportPublisher({
			journalPath,
			safetyBytes: 0n,
			getAvailableBytes: async () => 1024n ** 4n,
			removeStagingFile: async () => {
				throw Object.assign(new Error("file busy"), { code: "EBUSY" });
			},
		});

		await expect(
			exportPublisher.publish({
				finalPath,
				expectedBytes: 20,
				render: async (stagingPath) => {
					await writeFile(stagingPath, "partial new export");
					throw new Error("encoder failed");
				},
				verify: async () => undefined,
			}),
		).rejects.toMatchObject({ phase: "cleanup", code: "CLEANUP_FAILED", retryable: true });

		expect(await readFile(finalPath, "utf8")).toBe("old export");
		expect(
			(await readdir(directory)).filter((name) => name.startsWith("export-journal.json.owner-")),
		).toHaveLength(1);
	});

	it("keeps an existing export when verification fails", async () => {
		const finalPath = path.join(directory, "video.mp4");
		await writeFile(finalPath, "old export");

		await expect(
			publisher().publish({
				finalPath,
				expectedBytes: 20,
				render: async (stagingPath) => {
					await writeFile(stagingPath, "corrupt output");
					return null;
				},
				verify: async () => {
					throw new Error("tail frame is unreadable");
				},
			}),
		).rejects.toMatchObject({ phase: "verification", code: "VERIFICATION_FAILED" });

		expect(await readFile(finalPath, "utf8")).toBe("old export");
	});

	it("does not start rendering when already cancelled", async () => {
		const controller = new AbortController();
		controller.abort();
		const render = vi.fn(async () => null);

		await expect(
			publisher().publish({
				finalPath: path.join(directory, "video.mp4"),
				expectedBytes: 20,
				signal: controller.signal,
				render,
				verify: async () => undefined,
			}),
		).rejects.toMatchObject({ phase: "preflight", code: "CANCELLED" });
		expect(render).not.toHaveBeenCalled();
	});

	it("removes partial bytes when cancelled during rendering", async () => {
		const controller = new AbortController();
		let stagingPath = "";
		const operation = publisher().publish({
			finalPath: path.join(directory, "video.mp4"),
			expectedBytes: 20,
			signal: controller.signal,
			render: async (candidate, signal) => {
				stagingPath = candidate;
				await writeFile(candidate, "partial");
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
				return null;
			},
			verify: async () => undefined,
		});

		await vi.waitFor(() => expect(stagingPath).not.toBe(""));
		controller.abort();
		await expect(operation).rejects.toMatchObject({ phase: "rendering", code: "CANCELLED" });
		await expect(stat(stagingPath)).rejects.toThrow();
	});

	it("rejects before rendering when capacity is below the safety floor", async () => {
		const render = vi.fn(async () => null);

		await expect(
			publisher(5, async () => 1n).publish({
				finalPath: path.join(directory, "video.mp4"),
				expectedBytes: 1,
				render,
				verify: async () => undefined,
			}),
		).rejects.toMatchObject({ phase: "preflight", code: "INSUFFICIENT_SPACE" });
		expect(render).not.toHaveBeenCalled();
	});

	it("names the space an export needs and the space available", async () => {
		await expect(
			publisher(5, async () => 33_000_000_000n).publish({
				finalPath: path.join(directory, "video.mp4"),
				expectedBytes: 34_653_309_259,
				render: async () => null,
				verify: async () => undefined,
			}),
		).rejects.toThrow("It needs about 38 GB free, and this disk has 33 GB.");
	});

	it("reports disk-full errors consistently after preflight", async () => {
		const phases = ["rendering", "verification", "syncing", "publishing"] as const;
		for (const phase of phases) {
			const finalPath = path.join(directory, `${phase}.mp4`);
			await writeFile(finalPath, "old export");
			const diskFull = () => Object.assign(new Error("disk full"), { code: "ENOSPC" });
			const exportPublisher = new AtomicExportPublisher({
				journalPath: path.join(directory, `${phase}-journal.json`),
				safetyBytes: 0n,
				getAvailableBytes: async () => 1024n ** 4n,
				...(phase === "syncing" ? { syncFile: async () => Promise.reject(diskFull()) } : {}),
				...(phase === "publishing" ? { renameFile: async () => Promise.reject(diskFull()) } : {}),
			});

			await expect(
				exportPublisher.publish({
					finalPath,
					expectedBytes: 10,
					render: async (candidate) => {
						await writeFile(candidate, "new export");
						if (phase === "rendering") throw diskFull();
					},
					verify: async () => {
						if (phase === "verification") throw diskFull();
					},
				}),
			).rejects.toMatchObject({ phase, code: "INSUFFICIENT_SPACE", retryable: true });
			expect(await readFile(finalPath, "utf8")).toBe("old export");
		}
	});

	it("rejects an invalid output-size estimate as a preflight error", async () => {
		await expect(
			publisher().publish({
				finalPath: path.join(directory, "video.mp4"),
				expectedBytes: Number.NaN,
				render: async () => undefined,
				verify: async () => undefined,
			}),
		).rejects.toMatchObject({ phase: "preflight", code: "PREFLIGHT_FAILED" });
	});

	it("cancels a long render when the periodic capacity check fails", async () => {
		const finalPath = path.join(directory, "video.mp4");
		await writeFile(finalPath, "old export");
		let capacityChecks = 0;
		let stagingPath = "";
		const operation = publisher(2, async () => {
			capacityChecks += 1;
			return capacityChecks === 1 ? 1024n ** 4n : 1n;
		}).publish({
			finalPath,
			expectedBytes: 1024,
			render: async (candidate, signal) => {
				stagingPath = candidate;
				await writeFile(candidate, "partial");
				await new Promise<void>((_resolve, reject) => {
					if (signal.aborted) {
						reject(new Error("disk full"));
						return;
					}
					signal.addEventListener("abort", () => reject(new Error("disk full")), { once: true });
				});
			},
			verify: async () => undefined,
		});

		await expect(operation).rejects.toMatchObject({
			phase: "rendering",
			code: "INSUFFICIENT_SPACE",
		});
		expect(await readFile(finalPath, "utf8")).toBe("old export");
		await expect(stat(stagingPath)).rejects.toThrow();
	});

	it("cancels while staged media verification is running", async () => {
		const controller = new AbortController();
		let verificationStarted = false;
		const operation = publisher().publish({
			finalPath: path.join(directory, "video.mp4"),
			expectedBytes: 10,
			signal: controller.signal,
			render: async (candidate) => {
				await writeFile(candidate, "complete bytes");
			},
			verify: async (_candidate, _result, signal) => {
				verificationStarted = true;
				await new Promise<void>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				});
			},
		});

		await vi.waitFor(() => expect(verificationStarted).toBe(true));
		controller.abort();
		await expect(operation).rejects.toMatchObject({
			phase: "verification",
			code: "CANCELLED",
		});
	});

	it("honors cancellation after a file sync returns", async () => {
		const controller = new AbortController();
		const syncStarted = deferred();
		const syncGate = deferred();
		const exportPublisher = new AtomicExportPublisher({
			journalPath,
			safetyBytes: 0n,
			getAvailableBytes: async () => 1024n ** 4n,
			syncFile: async () => {
				syncStarted.resolve();
				await syncGate.promise;
			},
		});
		const operation = exportPublisher.publish({
			finalPath: path.join(directory, "video.mp4"),
			expectedBytes: 10,
			signal: controller.signal,
			render: async (candidate) => writeFile(candidate, "complete bytes"),
			verify: async () => undefined,
		});

		await syncStarted.promise;
		controller.abort();
		syncGate.resolve();
		await expect(operation).rejects.toMatchObject({ phase: "syncing", code: "CANCELLED" });
	});

	it("keeps the old final file when the atomic rename fails", async () => {
		const finalPath = path.join(directory, "video.mp4");
		await writeFile(finalPath, "old export");
		const exportPublisher = new AtomicExportPublisher({
			journalPath,
			safetyBytes: 0n,
			getAvailableBytes: async () => 1024n ** 4n,
			renameFile: async () => {
				throw Object.assign(new Error("destination unavailable"), { code: "EIO" });
			},
		});

		await expect(
			exportPublisher.publish({
				finalPath,
				expectedBytes: 10,
				render: async (candidate) => writeFile(candidate, "new export"),
				verify: async () => undefined,
			}),
		).rejects.toMatchObject({ phase: "publishing", code: "PUBLISH_FAILED" });
		expect(await readFile(finalPath, "utf8")).toBe("old export");
	});

	it("does not publish after cancellation during a rename retry", async () => {
		const controller = new AbortController();
		const finalPath = path.join(directory, "video.mp4");
		await writeFile(finalPath, "old export");
		const renameFile = vi.fn(async () => {
			controller.abort();
			throw Object.assign(new Error("file busy"), { code: "EBUSY" });
		});
		const exportPublisher = new AtomicExportPublisher({
			journalPath,
			safetyBytes: 0n,
			getAvailableBytes: async () => 1024n ** 4n,
			renameFile,
		});

		await expect(
			exportPublisher.publish({
				finalPath,
				expectedBytes: 10,
				signal: controller.signal,
				render: async (candidate) => writeFile(candidate, "new export"),
				verify: async () => undefined,
			}),
		).rejects.toMatchObject({ phase: "publishing", code: "CANCELLED" });
		expect(renameFile).toHaveBeenCalledTimes(1);
		expect(await readFile(finalPath, "utf8")).toBe("old export");
	});

	it("reports an unconfirmed-durability warning after the final rename has committed", async () => {
		const finalPath = path.join(directory, "video.mp4");
		const warnings: unknown[] = [];
		const exportPublisher = new AtomicExportPublisher({
			journalPath,
			safetyBytes: 0n,
			getAvailableBytes: async () => 1024n ** 4n,
			syncDirectory: async () => {
				throw Object.assign(new Error("directory sync failed"), { code: "EIO" });
			},
		});

		await expect(
			exportPublisher.publish({
				finalPath,
				expectedBytes: 10,
				render: async (candidate) => writeFile(candidate, "committed export"),
				verify: async () => undefined,
				onWarning: (warning) => warnings.push(warning),
			}),
		).resolves.toBeUndefined();
		expect(await readFile(finalPath, "utf8")).toBe("committed export");
		expect(warnings).toEqual([
			expect.objectContaining({
				phase: "publishing",
				code: "DURABILITY_UNCONFIRMED",
				retryable: false,
			}),
		]);
	});

	it("ignores an unsupported directory-sync operation after commit", async () => {
		const finalPath = path.join(directory, "video.mp4");
		const onWarning = vi.fn();
		const exportPublisher = new AtomicExportPublisher({
			journalPath,
			safetyBytes: 0n,
			getAvailableBytes: async () => 1024n ** 4n,
			syncDirectory: async () => {
				throw Object.assign(new Error("not supported"), { code: "ENOTSUP" });
			},
		});

		await exportPublisher.publish({
			finalPath,
			expectedBytes: 10,
			render: async (candidate) => writeFile(candidate, "committed export"),
			verify: async () => undefined,
			onWarning,
		});

		expect(await readFile(finalPath, "utf8")).toBe("committed export");
		expect(onWarning).not.toHaveBeenCalled();
	});

	it("cleans a journaled staging file before the next export", async () => {
		const stagingPath = path.join(directory, ".video.klippt-export-old.mp4");
		await writeFile(stagingPath, "crashed export");
		await writeFile(
			journalPath,
			JSON.stringify({
				version: 1,
				entries: [
					{
						stagingPath,
						finalPath: path.join(directory, "video.mp4"),
						startedAt: "2026-08-28T00:00:00.000Z",
					},
				],
			}),
		);

		await publisher().publish({
			finalPath: path.join(directory, "next.mp4"),
			expectedBytes: 4,
			render: async (candidate) => {
				await writeFile(candidate, "next");
				return null;
			},
			verify: async () => undefined,
		});

		await expect(stat(stagingPath)).rejects.toThrow();
	});

	it("preserves another live process's staged export and journal", async () => {
		const ownerPid = 77_777;
		const ownerToken = "00000000-0000-4000-8000-000000000000";
		const stagingPath = path.join(directory, `.video.klippt-export-${ownerPid}-${ownerToken}.mp4`);
		const ownerJournal = `${journalPath}.owner-${ownerPid}-${ownerToken}`;
		await writeFile(stagingPath, "active export");
		await writeFile(
			ownerJournal,
			JSON.stringify({
				version: 2,
				ownerPid,
				ownerToken,
				entries: [
					{
						stagingPath,
						finalPath: path.join(directory, "video.mp4"),
						startedAt: "2026-08-29T00:00:00.000Z",
					},
				],
			}),
		);
		const exportPublisher = new AtomicExportPublisher({
			journalPath,
			isProcessAlive: (pid) => pid === ownerPid,
		});

		await exportPublisher.initialize();

		await expect(readFile(stagingPath, "utf8")).resolves.toBe("active export");
		await expect(stat(ownerJournal)).resolves.toBeDefined();
	});

	it("cleans a staged export only after its owner process exits", async () => {
		const ownerPid = 88_888;
		const ownerToken = "00000000-0000-4000-8000-000000000001";
		const stagingPath = path.join(directory, `.video.klippt-export-${ownerPid}-${ownerToken}.mp4`);
		const ownerJournal = `${journalPath}.owner-${ownerPid}-${ownerToken}`;
		await writeFile(stagingPath, "orphaned export");
		await writeFile(
			ownerJournal,
			JSON.stringify({
				version: 2,
				ownerPid,
				ownerToken,
				entries: [
					{
						stagingPath,
						finalPath: path.join(directory, "video.mp4"),
						startedAt: "2026-08-29T00:00:00.000Z",
					},
				],
			}),
		);
		const exportPublisher = new AtomicExportPublisher({
			journalPath,
			isProcessAlive: () => false,
		});

		await exportPublisher.initialize();

		await expect(stat(stagingPath)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(ownerJournal)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("keeps a dead owner's journal when startup cleanup cannot remove its stage", async () => {
		const ownerPid = 99_999;
		const ownerToken = "00000000-0000-4000-8000-000000000002";
		const stagingPath = path.join(directory, `.video.klippt-export-${ownerPid}-${ownerToken}.mp4`);
		const ownerJournal = `${journalPath}.owner-${ownerPid}-${ownerToken}`;
		await writeFile(stagingPath, "busy orphan");
		await writeFile(
			ownerJournal,
			JSON.stringify({
				version: 2,
				ownerPid,
				ownerToken,
				entries: [
					{
						stagingPath,
						finalPath: path.join(directory, "video.mp4"),
						startedAt: "2026-08-29T00:00:00.000Z",
					},
				],
			}),
		);
		const exportPublisher = new AtomicExportPublisher({
			journalPath,
			isProcessAlive: () => false,
			removeStagingFile: async () => {
				throw Object.assign(new Error("file busy"), { code: "EBUSY" });
			},
		});

		await exportPublisher.initialize();

		await expect(readFile(stagingPath, "utf8")).resolves.toBe("busy orphan");
		await expect(stat(ownerJournal)).resolves.toBeDefined();
	});

	it.skipIf(process.platform === "win32")(
		"publishes through a selected output symlink",
		async () => {
			const targetPath = path.join(directory, "target.mp4");
			const linkPath = path.join(directory, "selected.mp4");
			await writeFile(targetPath, "old target");
			await symlink(targetPath, linkPath);

			await publisher().publish({
				finalPath: linkPath,
				expectedBytes: 3,
				render: async (stagingPath) => {
					await writeFile(stagingPath, "new");
					return null;
				},
				verify: async () => undefined,
			});

			expect(await readFile(targetPath, "utf8")).toBe("new");
			expect(await readFile(linkPath, "utf8")).toBe("new");
		},
	);

	it("keeps structured transaction errors unchanged", async () => {
		const error = new ExportTransactionError("known", "rendering", "INSUFFICIENT_SPACE", true);
		await expect(
			publisher().publish({
				finalPath: path.join(directory, "video.mp4"),
				expectedBytes: 1,
				render: async () => {
					throw error;
				},
				verify: async () => undefined,
			}),
		).rejects.toBe(error);
	});
});
