import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { DEFAULT_SHORTCUTS, mergeWithDefaults, type ShortcutsConfig } from "@/lib/shortcuts";
import { isMac as getIsMac } from "@/utils/platformUtils";

interface ShortcutsContextValue {
	shortcuts: ShortcutsConfig;
	isMac: boolean;
	setShortcuts: (config: ShortcutsConfig) => void;
	persistShortcuts: (config?: ShortcutsConfig) => Promise<boolean>;
	isConfigOpen: boolean;
	openConfig: () => void;
	closeConfig: () => void;
}

const ShortcutsContext = createContext<ShortcutsContextValue | null>(null);

export function useShortcuts(): ShortcutsContextValue {
	const ctx = useContext(ShortcutsContext);
	if (!ctx) throw new Error("useShortcuts must be used within <ShortcutsProvider>");
	return ctx;
}

export function ShortcutsProvider({ children }: { children: ReactNode }) {
	const [shortcuts, setShortcuts] = useState<ShortcutsConfig>(DEFAULT_SHORTCUTS);
	// `getIsMac()` is synchronous, but it reads `window.electronAPI`, so keep it
	// in an effect rather than in the initial state — that keeps the first render
	// free of any dependency on preload having been installed.
	const [isMac, setIsMac] = useState(false);
	const [isConfigOpen, setIsConfigOpen] = useState(false);

	useEffect(() => {
		setIsMac(getIsMac());

		window.electronAPI
			.getShortcuts?.()
			.then((saved) => {
				if (saved) {
					setShortcuts(mergeWithDefaults(saved as Partial<ShortcutsConfig>));
				}
			})
			.catch(() => {
				// Keep default shortcuts if persisted settings can't be loaded.
			});
	}, []);

	const persistShortcuts = useCallback(
		async (config?: ShortcutsConfig) => {
			const configToSave = config ?? shortcuts;
			const registration = await window.electronAPI.updateGlobalShortcuts?.(configToSave);
			if (registration && !registration.success) return false;

			const saved = await window.electronAPI.saveShortcuts?.(configToSave);
			if (saved && !saved.success) {
				// Keep the runtime and persisted configuration in sync if disk writing
				// fails after Electron accepted the new accelerators.
				await window.electronAPI.updateGlobalShortcuts?.(shortcuts);
				return false;
			}

			return true;
		},
		[shortcuts],
	);

	const openConfig = useCallback(() => setIsConfigOpen(true), []);
	const closeConfig = useCallback(() => setIsConfigOpen(false), []);

	const value = useMemo<ShortcutsContextValue>(
		() => ({
			shortcuts,
			isMac,
			setShortcuts,
			persistShortcuts,
			isConfigOpen,
			openConfig,
			closeConfig,
		}),
		[shortcuts, isMac, persistShortcuts, isConfigOpen, openConfig, closeConfig],
	);

	return <ShortcutsContext.Provider value={value}>{children}</ShortcutsContext.Provider>;
}
