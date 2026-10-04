import { lazy, Suspense, useEffect, useState } from "react";
import "./styles/fonts.css";
import "./styles/design-tokens.css";
import { EntitlementDialog } from "./components/entitlements/EntitlementDialog";
// Keep the countdown listener eager: ready-to-show can precede a lazy component
// mounting, which would lose the first countdown IPC value.
import { CountdownOverlay } from "./components/launch/CountdownOverlay.tsx";
import { Toaster } from "./components/ui/sonner";
import { TooltipProvider } from "./components/ui/tooltip";
import { useScopedT } from "./contexts/I18nContext";
import { ShortcutsProvider } from "./contexts/ShortcutsContext";
import { APP_DISPLAY_NAME } from "./lib/brand";
import { initializeEntitlements } from "./lib/entitlements/store";

const CameraPreviewWindow = lazy(() =>
	import("./components/launch/CameraPreviewWindow").then((module) => ({
		default: module.CameraPreviewWindow,
	})),
);

const LaunchWindow = lazy(() =>
	import("./components/launch/LaunchWindow").then((module) => ({ default: module.LaunchWindow })),
);

const NotesWindow = lazy(() =>
	import("./components/launch/NotesWindow").then((module) => ({ default: module.NotesWindow })),
);

const SourceSelector = lazy(() =>
	import("./components/launch/SourceSelector").then((module) => ({
		default: module.SourceSelector,
	})),
);

const VideoEditorEntry = lazy(() =>
	import("./components/ai-edition/AiEditionShell").then((module) => ({
		default: module.default,
	})),
);
const CliExportRunner = lazy(() => import("./cli/CliExportRunner"));
const CliRecordRunner = lazy(() => import("./cli/CliRecordRunner"));
const CliSourcesRunner = lazy(() => import("./cli/CliSourcesRunner"));
const CliCaptionsRunner = lazy(() => import("./cli/CliCaptionsRunner"));
const ShortcutsConfigDialog = lazy(() =>
	import("./components/video-editor/ShortcutsConfigDialog").then((module) => ({
		default: module.ShortcutsConfigDialog,
	})),
);

let customFontsInitialization: Promise<unknown> | undefined;

export default function App() {
	const [windowType, setWindowType] = useState(
		() => new URLSearchParams(window.location.search).get("windowType") || "",
	);
	const showNotes = new URLSearchParams(window.location.search).get("showNotes") === "true";

	const tEditor = useScopedT("editor");

	useEffect(() => {
		const type = new URLSearchParams(window.location.search).get("windowType") || "";
		if (type !== windowType) {
			setWindowType(type);
		}

		if (
			type === "hud-overlay" ||
			type === "camera-preview" ||
			type === "source-selector" ||
			type === "countdown-overlay"
		) {
			document.body.style.background = "transparent";
			document.documentElement.style.background = "transparent";
			document.getElementById("root")?.style.setProperty("background", "transparent");
		}

		// HUD is a fixed-size BrowserWindow; pin the document shell and hide overflow
		// so the renderer can't introduce scrollbars (see issue #305).
		if (type === "hud-overlay" || type === "camera-preview") {
			document.documentElement.style.height = "100%";
			document.documentElement.style.overflow = "hidden";
			document.body.style.height = "100%";
			document.body.style.margin = "0";
			document.body.style.overflow = "hidden";
			const root = document.getElementById("root");
			root?.style.setProperty("height", "100%");
			root?.style.setProperty("min-height", "0");
			root?.style.setProperty("overflow", "hidden");
		}
	}, [windowType]);

	useEffect(() => {
		// Only caption-rendering windows need user fonts. Auxiliary windows must not
		// repeat font requests or initialize caption storage.
		if (showNotes || (windowType !== "editor" && windowType !== "cli-export")) return;
		customFontsInitialization ??= import("./lib/customFonts").then(({ loadAllCustomFonts }) =>
			loadAllCustomFonts(),
		);
		customFontsInitialization.catch((error) => {
			console.error("Failed to load custom fonts:", error);
		});
	}, [windowType, showNotes]);

	useEffect(() => {
		let disposed = false;
		let dispose: () => void = () => undefined;
		void initializeEntitlements()
			.then((cleanup) => {
				if (disposed) cleanup();
				else dispose = cleanup;
			})
			.catch((error) => console.warn("Could not load Klippt entitlement:", error));
		return () => {
			disposed = true;
			dispose();
		};
	}, []);

	const content = (() => {
		switch (windowType) {
			case "hud-overlay":
				return <LaunchWindow />;
			case "camera-preview":
				return <CameraPreviewWindow />;
			case "source-selector":
				return <SourceSelector />;
			case "countdown-overlay":
				return <CountdownOverlay />;
			case "cli-export":
				return (
					<Suspense fallback={null}>
						<CliExportRunner />
					</Suspense>
				);
			case "cli-record":
				return (
					<Suspense fallback={null}>
						<CliRecordRunner />
					</Suspense>
				);
			case "cli-sources":
				return (
					<Suspense fallback={null}>
						<CliSourcesRunner />
					</Suspense>
				);
			case "cli-captions":
				return (
					<Suspense fallback={null}>
						<CliCaptionsRunner />
					</Suspense>
				);
			case "editor":
				return (
					<ShortcutsProvider>
						<Suspense
							fallback={
								<div className="flex flex-col items-center justify-center gap-3 h-screen bg-[#09090b]">
									<svg
										className="animate-spin text-[var(--accent)]"
										xmlns="http://www.w3.org/2000/svg"
										fill="none"
										viewBox="0 0 24 24"
										width={28}
										height={28}
									>
										<circle
											className="opacity-25"
											cx="12"
											cy="12"
											r="10"
											stroke="currentColor"
											strokeWidth="4"
										/>
										<path
											className="opacity-75"
											fill="currentColor"
											d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
										/>
									</svg>
									<span className="text-white/50 text-sm">{tEditor("loadingEditor")}</span>
								</div>
							}
						>
							<VideoEditorEntry />
							<ShortcutsConfigDialog />
						</Suspense>
					</ShortcutsProvider>
				);
			default:
				return (
					<div>
						<div className="w-full h-full bg-background text-foreground">
							<h1 translate="no">{APP_DISPLAY_NAME}</h1>
						</div>
					</div>
				);
		}
	})();

	return (
		<TooltipProvider>
			<Suspense fallback={null}>{showNotes ? <NotesWindow /> : content}</Suspense>
			<EntitlementDialog />
			{/* The recorder pill hosts its own, just above the pill. */}
			{windowType === "hud-overlay" ? null : <Toaster theme="dark" />}
		</TooltipProvider>
	);
}
