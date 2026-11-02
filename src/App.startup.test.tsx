// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "./App";

const startup = vi.hoisted(() => ({ fonts: vi.fn(async () => []), loaded: new Set<string>() }));
vi.mock("./lib/customFonts", () => ({ loadAllCustomFonts: startup.fonts }));
vi.mock("./contexts/I18nContext", () => ({ useScopedT: () => (key: string) => key }));
vi.mock("./contexts/ShortcutsContext", () => ({
	ShortcutsProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/ui/sonner", () => ({ Toaster: () => null }));
vi.mock("./components/ui/tooltip", () => ({
	TooltipProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("./components/launch/CameraPreviewWindow", () => {
	startup.loaded.add("camera");
	return { CameraPreviewWindow: () => <div>camera window</div> };
});
vi.mock("./components/launch/LaunchWindow", () => {
	startup.loaded.add("hud");
	return { LaunchWindow: () => <div>hud window</div> };
});
vi.mock("./components/launch/NotesWindow", () => {
	startup.loaded.add("notes");
	return { NotesWindow: () => <div>notes window</div> };
});
vi.mock("./components/launch/SourceSelector", () => {
	startup.loaded.add("sources");
	return { SourceSelector: () => <div>sources window</div> };
});
vi.mock("./components/ai-edition/AiEditionShell", () => ({
	default: () => <div>editor window</div>,
}));
vi.mock("./components/video-editor/ShortcutsConfigDialog", () => ({
	ShortcutsConfigDialog: () => null,
}));

afterEach(cleanup);

describe("window startup", () => {
	it("loads only the requested camera module and leaves custom fonts idle", async () => {
		window.history.replaceState(null, "", "?windowType=camera-preview");
		render(<App />);
		await screen.findByText("camera window");
		expect([...startup.loaded]).toEqual(["camera"]);
		expect(startup.fonts).not.toHaveBeenCalled();
	});

	it("mounts the countdown listener immediately without loading another window", async () => {
		let onValue: ((value: number | null) => void) | undefined;
		window.electronAPI = {
			onCountdownOverlayValue: (handler) => {
				onValue = handler;
				return () => undefined;
			},
		} as typeof window.electronAPI;
		window.history.replaceState(null, "", "?windowType=countdown-overlay");
		render(<App />);
		expect(onValue).toBeDefined();
		act(() => onValue?.(3));
		expect(screen.getByText("3")).toBeTruthy();
		expect([...startup.loaded]).toEqual(["camera"]);
		expect(startup.fonts).not.toHaveBeenCalled();
	});

	it("initializes editor custom fonts once under StrictMode", async () => {
		window.history.replaceState(null, "", "?windowType=editor");
		render(
			<StrictMode>
				<App />
			</StrictMode>,
		);
		await screen.findByText("editor window");
		await waitFor(() => expect(startup.fonts).toHaveBeenCalledTimes(1));
	});
});
