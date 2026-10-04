import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "openscreen-theme";

function readStoredTheme(): Theme {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw === "light" ? "light" : "dark";
	} catch {
		return "dark";
	}
}

export function applyTheme(theme: Theme) {
	if (theme === "dark") {
		document.documentElement.setAttribute("data-theme", "dark");
	} else {
		document.documentElement.removeAttribute("data-theme");
	}
	// Keep Tailwind's dark selector in sync with the canonical token theme.
	// Tailwind no longer owns a parallel color palette; this class remains for
	// component-level `dark:` variants.
	document.documentElement.classList.toggle("dark", theme === "dark");

	// Repaint the native Windows/Linux window controls in the new theme, so the
	// titlebar reads as one continuous surface with the app. Reading the tokens
	// back keeps the palette in design-tokens.css only. No-op elsewhere.
	const css = getComputedStyle(document.documentElement);
	window.electronAPI?.setTitleBarOverlay?.(
		css.getPropertyValue("--bg").trim(),
		css.getPropertyValue("--muted").trim(),
	);
}

export function useTheme(): { theme: Theme; toggle: () => void; setTheme: (t: Theme) => void } {
	const [theme, setThemeState] = useState<Theme>(() => readStoredTheme());

	useEffect(() => {
		applyTheme(theme);
		try {
			localStorage.setItem(STORAGE_KEY, theme);
		} catch {
			// ponytail: storage may be unavailable in private browsing
		}
	}, [theme]);

	const toggle = useCallback(() => {
		setThemeState((prev) => (prev === "dark" ? "light" : "dark"));
	}, []);

	const setTheme = useCallback((t: Theme) => {
		setThemeState(t);
	}, []);

	return { theme, toggle, setTheme };
}
