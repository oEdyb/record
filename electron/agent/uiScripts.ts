/**
 * Page scripts for the agent's window-level controls, run with `executeJavaScript` in a Klippt
 * window. They read and click the DOM the viewer sees; nothing reaches the host pointer.
 * A control's label is its aria-label, else its title, else its visible text.
 */

const PRELUDE = `
const selector = 'button, [role="button"], [role="switch"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="slider"], a[href], input, select, textarea';
const visible = (el) => {
	const r = el.getBoundingClientRect();
	if (r.width === 0 || r.height === 0) return false;
	const s = getComputedStyle(el);
	return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0;
};
const labelOf = (el) =>
	(el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText || el.value || el.placeholder || "")
		.replace(/\\s+/g, " ").trim().slice(0, 120);
const controls = () => [...document.querySelectorAll(selector)].filter(visible);
`;

/** Runs a body in the page; a throw comes back as { error }, which survives the IPC hop intact. */
const wrap = (body: string) =>
	`(() => { try {${PRELUDE}${body}} catch (e) { return { error: String((e && e.message) || e) }; } })()`;

export function controlsScript(): string {
	return wrap(`
	return {
		title: document.title,
		controls: controls().map((el) => {
			const r = el.getBoundingClientRect();
			return {
				label: labelOf(el),
				role: el.getAttribute("role") || el.tagName.toLowerCase(),
				pressed: el.getAttribute("aria-pressed") ?? el.getAttribute("aria-checked") ?? undefined,
				disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
				x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height),
			};
		}).filter((c) => c.label),
		text: document.body.innerText.replace(/\\n{3,}/g, "\\n\\n").slice(0, 4000),
	};
`);
}

/** Clicks the nth visible control whose label matches exactly, else the nth that contains it. */
export function clickScript(label: string, nth: number): string {
	return wrap(`
	const want = ${JSON.stringify(label.toLowerCase())};
	const all = controls();
	const exact = all.filter((el) => labelOf(el).toLowerCase() === want);
	const loose = all.filter((el) => labelOf(el).toLowerCase().includes(want));
	const pool = exact.length ? exact : loose;
	const el = pool[${Math.max(0, Math.floor(nth))}];
	if (!el) throw new Error("No visible control labelled " + JSON.stringify(${JSON.stringify(label)}) + ". Run ui.controls to see the labels.");
	if (el.disabled || el.getAttribute("aria-disabled") === "true") throw new Error("That control is disabled: " + labelOf(el));
	el.scrollIntoView({ block: "nearest" });
	el.click();
	return { clicked: labelOf(el), matches: pool.length };
`);
}

/** Types into a field, firing the input event React listens for. */
export function typeScript(label: string, text: string): string {
	return wrap(`
	const want = ${JSON.stringify(label.toLowerCase())};
	const fields = controls().filter((el) => /^(input|textarea)$/i.test(el.tagName));
	const el = fields.find((f) => labelOf(f).toLowerCase().includes(want)) ?? (want === "" ? document.activeElement : null);
	if (!el || !/^(input|textarea)$/i.test(el.tagName)) throw new Error("No text field labelled " + JSON.stringify(${JSON.stringify(label)}) + ".");
	const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set;
	setter.call(el, ${JSON.stringify(text)});
	el.dispatchEvent(new Event("input", { bubbles: true }));
	el.dispatchEvent(new Event("change", { bubbles: true }));
	return { field: labelOf(el), value: el.value };
`);
}
