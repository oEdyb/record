import { z } from "zod";
import { documentSchema } from "../../../src/lib/ai-edition/schema";
import type {
	AiEditionAssetResult,
	AiEditionDocumentResult,
	AiEditionProjectSummary,
	AiEditionTransactionResult,
	AiEditionWriteGuard,
} from "../../../src/native/contracts";
import { agentHistoryIntentSchema } from "../../ai-edition/agentHistory";
import type { DocumentService } from "../../ai-edition/document-service";
import { ProjectTransactionError } from "../../ai-edition/projectTransactions";

export interface AiEditionServiceOptions {
	documents: DocumentService;
	resolveMediaPath?: (path: string) => Promise<string | null>;
}

export class AiEditionService {
	constructor(private readonly options: AiEditionServiceOptions) {}

	async listProjects(): Promise<AiEditionProjectSummary[]> {
		return this.options.documents.listProjects();
	}

	async get(projectId: string): Promise<AiEditionDocumentResult> {
		try {
			const view = await this.options.documents.getProjectView(projectId);
			// Project content cannot grant filesystem access. Resolution only consults
			// prior native-picker grants and app-owned paths, including after restart.
			const paths = new Set([
				...view.document.assets.flatMap((asset) => [
					asset.originalPath,
					asset.cameraTrack?.sourcePath,
				]),
				...(view.document.audioAssets ?? []).map((asset) => asset.originalPath),
			]);
			for (const source of paths) if (source) await this.options.resolveMediaPath?.(source);
			return { success: true, ...view };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async create(title?: string): Promise<AiEditionDocumentResult> {
		try {
			const document = await this.options.documents.createProject(title ?? "");
			return { success: true, document };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private transactionFailure(error: unknown): AiEditionTransactionResult {
		return {
			success: false,
			error: error instanceof Error ? error.message : String(error),
			errorCode:
				error instanceof ProjectTransactionError
					? error.code
					: error instanceof z.ZodError
						? "INVALID_INPUT"
						: "EXECUTION_FAILED",
		};
	}
	async snapshot(projectId: string): Promise<AiEditionTransactionResult> {
		try {
			const snapshot = await this.options.documents.getTransactionSnapshot(projectId);
			return { success: true, ...snapshot };
		} catch (error) {
			return this.transactionFailure(error);
		}
	}
	async commit(
		projectId: string,
		document: unknown,
		guard: AiEditionWriteGuard,
	): Promise<AiEditionTransactionResult> {
		let receipt: AiEditionTransactionResult["receipt"];
		try {
			const parsedGuard = z
				.object({
					requestId: z.string().min(1).max(256),
					recordUndo: z.boolean().optional(),
					agentHistory: agentHistoryIntentSchema.optional(),
					expected: z
						.object({
							mutationIdentity: z.string().min(1),
							revision: z.string().min(1),
							fileHash: z.string().regex(/^[a-f0-9]{64}$/),
						})
						.strict(),
				})
				.strict()
				.parse(guard);
			const parsed = documentSchema.parse(document);
			if (parsed.project.id !== projectId)
				return {
					success: false,
					errorCode: "IDENTITY_CHANGED",
					error: "Replacement project identity does not match request",
				};
			receipt = await this.options.documents.commitTransaction(
				projectId,
				{ ...parsedGuard, payload: { projectId, document: parsed } },
				() => parsed,
			);
			const current = await this.options.documents.getTransactionSnapshot(projectId);
			return {
				success: true,
				...current,
				receipt,
				snapshotMatchesReceipt: current.version.revision === receipt.revision,
			};
		} catch (error) {
			// A later snapshot read can fail after a successful durable commit. Keep its
			// receipt and success rather than inviting the caller to execute a new edit.
			if (receipt)
				return {
					success: true,
					receipt,
					errorCode: "SNAPSHOT_UNAVAILABLE",
					error: error instanceof Error ? error.message : String(error),
				};
			return this.transactionFailure(error);
		}
	}
	async receipt(
		projectId: string,
		operationRequestId: string,
	): Promise<AiEditionTransactionResult> {
		try {
			const requestId = z.string().min(1).max(256).parse(operationRequestId);
			return {
				success: true,
				receipt: await this.options.documents.getTransactionReceipt(projectId, requestId),
			};
		} catch (error) {
			return this.transactionFailure(error);
		}
	}

	async save(document: unknown): Promise<AiEditionDocumentResult> {
		try {
			const parsed = documentSchema.parse(document);
			const saved = await this.options.documents.saveProject(parsed);
			return { success: true, document: saved };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async deleteProject(projectId: string): Promise<AiEditionDocumentResult> {
		try {
			await this.options.documents.deleteProject(projectId);
			return { success: true };
		} catch (error) {
			return {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async importProject(document: unknown): Promise<AiEditionDocumentResult> {
		return { success: true, document: await this.options.documents.importProject(document) };
	}
	async prepareAudioAsset(projectId: string, selectedPath: string) {
		return { asset: await this.options.documents.prepareAudioAsset(projectId, selectedPath) };
	}

	async prepareAsset(projectId: string, path: string, label?: string, recordingImportId?: string) {
		return {
			asset: await this.options.documents.prepareAsset(projectId, {
				path,
				label,
				recordingImportId,
			}),
		};
	}

	async addAsset(
		projectId: string,
		path: string,
		label?: string,
		recordingImportId?: string,
	): Promise<AiEditionAssetResult> {
		const document = await this.options.documents.addAsset(projectId, {
			path,
			label,
			recordingImportId,
		});
		const assetId = document.project.primaryAssetId ?? document.assets.at(-1)?.id ?? "";
		return { assetId, document };
	}

	async removeAsset(projectId: string, assetId: string): Promise<AiEditionAssetResult> {
		const document = await this.options.documents.removeAsset(projectId, assetId);
		return { assetId, document };
	}
}
