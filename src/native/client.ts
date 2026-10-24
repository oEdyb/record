import { useEntitlementStore } from "@/lib/entitlements/store";
import {
	type AiEditionAssetResult,
	type AiEditionDocumentResult,
	type AiEditionProjectSummary,
	type AiEditionTransactionResult,
	type AiEditionWriteGuard,
	type CursorCapabilities,
	type CursorRecordingData,
	type CursorTelemetryPoint,
	NATIVE_BRIDGE_CHANNEL,
	type NativeBridgeErrorCode,
	type NativeBridgeRequest,
	type NativeBridgeResponse,
	type NativePlatform,
	type ProjectContext,
	type ProjectFileResult,
	type ProjectPathResult,
	type SystemCapabilities,
} from "./contracts";

export class NativeBridgeClientError extends Error {
	constructor(
		message: string,
		readonly code: NativeBridgeErrorCode,
		readonly details?: import("./contracts").NativeBridgeError["details"],
		readonly retryable = false,
	) {
		super(message);
		this.name = "NativeBridgeClientError";
	}
}

function createRequestId() {
	if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
		return crypto.randomUUID();
	}

	return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getElectronBridge() {
	if (!window.electronAPI?.invokeNativeBridge) {
		throw new Error(
			`Native bridge unavailable. Expected ${NATIVE_BRIDGE_CHANNEL} transport in preload.`,
		);
	}

	return window.electronAPI.invokeNativeBridge;
}

async function invokeNativeBridge<TData = unknown>(
	request: NativeBridgeRequest,
): Promise<NativeBridgeResponse<TData>> {
	const invoke = getElectronBridge();
	return invoke({
		...request,
		requestId: request.requestId ?? createRequestId(),
	});
}

export async function requireNativeBridgeData<TData>(request: NativeBridgeRequest): Promise<TData> {
	const response = await invokeNativeBridge<TData>(request);
	if (!response.ok) {
		if (response.error.code === "ENTITLEMENT_REQUIRED") {
			useEntitlementStore.getState().openDialog();
		}
		throw new NativeBridgeClientError(
			response.error.message,
			response.error.code,
			response.error.details,
			response.error.retryable,
		);
	}

	return response.data;
}

export const nativeBridgeClient = {
	rawInvoke: invokeNativeBridge,
	system: {
		getPlatform: () =>
			requireNativeBridgeData<NativePlatform>({
				domain: "system",
				action: "getPlatform",
			}),
		getAssetBasePath: () =>
			requireNativeBridgeData<string | null>({
				domain: "system",
				action: "getAssetBasePath",
			}),
		getCapabilities: () =>
			requireNativeBridgeData<SystemCapabilities>({
				domain: "system",
				action: "getCapabilities",
			}),
	},
	project: {
		getCurrentContext: () =>
			requireNativeBridgeData<ProjectContext>({
				domain: "project",
				action: "getCurrentContext",
			}),
		saveProjectFile: (projectData: unknown, suggestedName?: string, existingProjectPath?: string) =>
			requireNativeBridgeData<ProjectFileResult>({
				domain: "project",
				action: "saveProjectFile",
				payload: {
					projectData,
					suggestedName,
					existingProjectPath,
				},
			}),
		loadProjectFile: (projectFolder?: string) =>
			requireNativeBridgeData<ProjectFileResult>({
				domain: "project",
				action: "loadProjectFile",
				payload: { projectFolder },
			}),
		loadCurrentProjectFile: () =>
			requireNativeBridgeData<ProjectFileResult>({
				domain: "project",
				action: "loadCurrentProjectFile",
			}),
		loadProjectFileFromPath: (path: string) =>
			requireNativeBridgeData<ProjectFileResult>({
				domain: "project",
				action: "loadProjectFileFromPath",
				payload: { path },
			}),
		setCurrentVideoPath: (path: string) =>
			requireNativeBridgeData<ProjectPathResult>({
				domain: "project",
				action: "setCurrentVideoPath",
				payload: { path },
			}),
		getCurrentVideoPath: () =>
			requireNativeBridgeData<ProjectPathResult>({
				domain: "project",
				action: "getCurrentVideoPath",
			}),
		clearCurrentVideoPath: () =>
			requireNativeBridgeData<ProjectPathResult>({
				domain: "project",
				action: "clearCurrentVideoPath",
			}),
	},
	cursor: {
		getCapabilities: () =>
			requireNativeBridgeData<CursorCapabilities>({
				domain: "cursor",
				action: "getCapabilities",
			}),
		getRecordingData: (videoPath?: string) =>
			requireNativeBridgeData<CursorRecordingData>({
				domain: "cursor",
				action: "getRecordingData",
				payload: videoPath ? { videoPath } : {},
			}),
		getTelemetry: (videoPath?: string) =>
			requireNativeBridgeData<CursorTelemetryPoint[]>({
				domain: "cursor",
				action: "getTelemetry",
				payload: videoPath ? { videoPath } : {},
			}),
	},
	aiEdition: {
		exportSources: (document: unknown, cleanCut?: import("@/lib/cleanCut/types").CleanCutExport) =>
			requireNativeBridgeData<import("./contracts").SourceHandoffResult>({
				domain: "aiEdition",
				action: "document.exportSources",
				payload: cleanCut ? { document, cleanCut } : { document },
			}),
		listProjects: () =>
			requireNativeBridgeData<AiEditionProjectSummary[]>({
				domain: "aiEdition",
				action: "document.listProjects",
			}),
		getLatest: () =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "document.getLatest",
			}),
		get: (projectId: string) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "document.get",
				payload: { projectId },
			}),
		create: (title?: string) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "document.create",
				payload: { title },
			}),
		snapshot: (projectId: string) =>
			requireNativeBridgeData<AiEditionTransactionResult>({
				domain: "aiEdition",
				action: "document.snapshot",
				payload: { projectId },
			}),
		commit: (projectId: string, document: unknown, guard: AiEditionWriteGuard) =>
			requireNativeBridgeData<AiEditionTransactionResult>({
				domain: "aiEdition",
				action: "document.commit",
				payload: { projectId, document, guard },
			}),
		receipt: (projectId: string, operationRequestId: string) =>
			requireNativeBridgeData<AiEditionTransactionResult>({
				domain: "aiEdition",
				action: "document.receipt",
				payload: { projectId, operationRequestId },
			}),

		save: (document: unknown) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "document.save",
				payload: { document },
			}),
		delete: (projectId: string) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "document.delete",
				payload: { projectId },
			}),
		importProject: (document: unknown) =>
			requireNativeBridgeData<AiEditionDocumentResult>({
				domain: "aiEdition",
				action: "document.import",
				payload: { document },
			}),
		prepareAsset: (projectId: string, path: string, label?: string, recordingImportId?: string) =>
			requireNativeBridgeData<{ asset: unknown }>({
				domain: "aiEdition",
				action: "document.prepareAsset",
				payload: { projectId, path, label, recordingImportId },
			}),

		addAsset: (projectId: string, path: string, label?: string, recordingImportId?: string) =>
			requireNativeBridgeData<AiEditionAssetResult>({
				domain: "aiEdition",
				action: "document.addAsset",
				payload: { projectId, path, label, recordingImportId },
			}),
		removeAsset: (projectId: string, assetId: string) =>
			requireNativeBridgeData<AiEditionAssetResult>({
				domain: "aiEdition",
				action: "document.removeAsset",
				payload: { projectId, assetId },
			}),
	},
};
