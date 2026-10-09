import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.tsx";
import { I18nProvider } from "./contexts/I18nContext";
import { clearStaleSourceCache } from "./lib/exporter/localSourceFile";
import "./hooks/rendererConsoleForwarder";
import "./index.css";

// Install browser-only schema and IPC shims before React mounts. Electron already
// supplies its bridge; its auxiliary windows never need this module graph.
if (!window.electronAPI) {
	const { installBrowserShims } = await import("./native/browserShim");
	installBrowserShims();
}

const windowType = new URLSearchParams(window.location.search).get("windowType") || "";

// The editor owns cache maintenance. Other windows, including CLI runners, can
// hold their own active cache namespace and must never delete each other's data.
if (windowType === "editor") {
	const cleanSourceCache = () => {
		void clearStaleSourceCache()
			.then(({ failedEntries }) => {
				if (failedEntries > 0) {
					console.warn(`Could not remove ${failedEntries} stale source-cache entries.`);
				}
			})
			.catch((error) => console.warn("Could not clean the source cache.", error));
	};
	cleanSourceCache();
	window.setInterval(cleanSourceCache, 5 * 60_000);
}
const showNotes = new URLSearchParams(window.location.search).get("showNotes") === "true";
if (
	showNotes ||
	windowType === "hud-overlay" ||
	windowType === "camera-preview" ||
	windowType === "transcript" ||
	windowType === "source-selector" ||
	windowType === "countdown-overlay"
) {
	document.body.style.background = "transparent";
	document.documentElement.style.background = "transparent";
	document.getElementById("root")?.style.setProperty("background", "transparent");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<I18nProvider>
			<App />
		</I18nProvider>
	</React.StrictMode>,
);
