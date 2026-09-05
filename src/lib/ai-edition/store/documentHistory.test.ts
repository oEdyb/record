import { beforeEach, describe, expect, it } from "vitest";
import { type AxcutDocument, createEmptyDocument } from "../schema";
import {
	clearDocumentHistory,
	patchDocumentHistory,
	recordDocumentSnapshot,
	takeRedoDocument,
	takeUndoDocument,
} from "./documentHistory";

const document = () => createEmptyDocument({ projectId: "history", title: "Original" });

describe("document history ownership", () => {
	beforeEach(clearDocumentHistory);

	it("shares unchanged snapshot branches without retaining caller-owned objects", () => {
		const original = document();
		recordDocumentSnapshot(original);
		recordDocumentSnapshot({ ...original, project: { ...original.project, title: "Second" } });
		const seen: AxcutDocument[] = [];
		patchDocumentHistory("history", (doc) => {
			seen.push(doc);
			return doc;
		});
		expect(seen[0].timeline).toBe(seen[1].timeline);
		expect(seen[0].timeline).not.toBe(original.timeline);
		original.project.title = "Mutated outside history";
		expect(takeUndoDocument(original)?.project.title).toBe("Second");
		expect(takeUndoDocument(original)?.project.title).toBe("Original");
	});

	it("coalesces a patch without copying unchanged data and isolates redo", () => {
		const original = document();
		recordDocumentSnapshot(original);
		let before: AxcutDocument | undefined;
		patchDocumentHistory("history", (doc) => {
			before = doc;
			return { ...doc, project: { ...doc.project, title: "Enhanced" } };
		});
		patchDocumentHistory("history", (doc) => {
			expect(doc.timeline).toBe(before?.timeline);
			return doc;
		});
		const restored = takeUndoDocument(original);
		expect(restored?.project.title).toBe("Enhanced");
		if (!restored) throw new Error("missing history");
		original.project.title = "Changed after undo";
		expect(takeRedoDocument(restored)?.project.title).toBe("Original");
	});

	it("re-reads reused mutable branches and isolates nested patch results", () => {
		const original = document();
		original.transcript = {
			assetId: "asset",
			language: "en",
			evidenceStatus: "legacy-unverified",
			sources: [],
			segments: [],
			words: [{ id: "word", segmentId: "segment", text: "Original", startSec: 0, endSec: 1 }],
		};
		recordDocumentSnapshot(original);
		original.transcript.words[0].text = "Changed";
		recordDocumentSnapshot(original);
		let calls = 0;
		patchDocumentHistory("history", (doc) => {
			expect(doc.transcript?.words[0].text).toBe(calls++ === 0 ? "Original" : "Changed");
			expect(Object.isFrozen(doc.transcript?.words[0])).toBe(true);
			return doc;
		});
		const project = { ...original.project, title: "Enhanced" };
		patchDocumentHistory("history", (doc) => ({ ...doc, project }));
		project.title = "Mutated patch result";
		expect(takeUndoDocument(original)?.project.title).toBe("Enhanced");
	});

	it("publishes no partial patch when a later history entry fails", () => {
		const original = document();
		recordDocumentSnapshot(original);
		recordDocumentSnapshot({ ...original, project: { ...original.project, title: "Second" } });
		let calls = 0;
		expect(() =>
			patchDocumentHistory("history", (doc) => {
				if (++calls === 2) throw new Error("patch failed");
				return { ...doc, project: { ...doc.project, title: "Partial patch" } };
			}),
		).toThrow("patch failed");
		expect(takeUndoDocument(original)?.project.title).toBe("Second");
		expect(takeUndoDocument(original)?.project.title).toBe("Original");
	});

	it("rejects a mutating patch without corrupting history", () => {
		const original = document();
		recordDocumentSnapshot(original);
		expect(() =>
			patchDocumentHistory("history", (doc) => {
				doc.project.title = "Bad mutation";
				return doc;
			}),
		).toThrow();
		expect(takeUndoDocument(original)?.project.title).toBe("Original");
	});

	it("retains fifty Undo steps when a large asset branch is shared", () => {
		const original = document();
		original.assets = [
			{
				id: "asset",
				kind: "video",
				originalPath: "/recording.mp4",
				label: "x".repeat(1024 * 1024),
				cameraTrack: null,
			},
		];
		for (let i = 0; i < 50; i += 1) {
			recordDocumentSnapshot({ ...original, project: { ...original.project, title: `Edit ${i}` } });
		}
		for (let i = 49; i >= 0; i -= 1) {
			expect(takeUndoDocument(original)?.project.title).toBe(`Edit ${i}`);
		}
		expect(takeUndoDocument(original)).toBeNull();
	});

	it("bounds distinct large snapshots while retaining the most recent Undo step", () => {
		const original = document();
		for (let i = 0; i < 12; i += 1) {
			recordDocumentSnapshot({
				...original,
				project: { ...original.project, title: `${i}:${"x".repeat(4 * 1024 * 1024)}` },
			});
		}
		let count = 0;
		let next = takeUndoDocument(original);
		expect(next?.project.title.startsWith("11:")).toBe(true);
		while (next) {
			count += 1;
			next = takeUndoDocument(original);
		}
		expect(count).toBeLessThan(12);
		expect(count).toBeGreaterThan(0);
	});
});
