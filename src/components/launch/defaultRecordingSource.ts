type SourceApi = Pick<
	Window["electronAPI"],
	| "getSelectedSource"
	| "getSources"
	| "selectSource"
	| "getPlatform"
	| "getRecordingWorkspaceContext"
>;

/** A fresh standalone recorder can use a screen without opening a second picker. */
export async function ensureDefaultRecordingSource(
	api: SourceApi,
	isCurrent: () => boolean,
): Promise<ProcessedDesktopSource | null> {
	const current = await api.getSelectedSource();
	if (current || !isCurrent()) return current;
	// Linux's portal owns the source. Project workspaces retain their own setup,
	// including an unavailable source that the user must explicitly replace.
	if (api.getPlatform?.() === "linux" || !api.getSources || !api.selectSource) return null;
	const workspace = await api.getRecordingWorkspaceContext?.();
	if (!isCurrent() || workspace?.context) return null;
	const sources = await api.getSources({
		types: ["screen"],
		thumbnailSize: { width: 1, height: 1 },
		fetchWindowIcons: false,
	});
	if (!isCurrent()) return null;
	const chosen = await api.getSelectedSource();
	if (chosen || !isCurrent()) return chosen;
	const screen = sources.find((source) => source.id.startsWith("screen:"));
	if (!screen) return null;
	return api.selectSource(screen);
}
