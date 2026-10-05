export type Theme = "light" | "dark";

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
