import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import postcss from "postcss";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dirname, "..");
const STYLES = {
	"src/components/ui/app-select.module.css": ["--editor-accent-soft"],
	"src/components/ui/app-menu.module.css": [
		"--editor-accent-strong",
		"--radix-dropdown-menu-content-transform-origin",
	],
	"src/components/ui/inspector/inspector.module.css": ["--editor-accent"],
	"src/components/video-editor/ShortcutsConfigDialog.module.css": [
		"--editor-accent-strong",
		"--accent-on",
	],
};
const GREEN = /(?:\b(?:green|emerald|lime)(?:\b|-)|#(?:10b981|22c55e|34b27b|2d9e6c)\b)/i;

// This is a source policy, not proof of the browser's final computed styles.
// Parse declarations so comments cannot satisfy token rules or trigger color bans.
export function inspectStylePolicy(source, requiredTokens = []) {
	const values = [];
	postcss.parse(source).walkDecls((declaration) => values.push(declaration.value));
	return [
		...values.filter((value) => GREEN.test(value)).map((value) => `Green theme value: ${value}`),
		...requiredTokens
			.filter((token) => !values.some((value) => value.includes(`var(${token})`)))
			.map((token) => `Missing semantic token: ${token}`),
	];
}

export function hasNativeSelect(source, filename = "component.tsx") {
	if (!source.includes("<select")) return false;
	const file = ts.createSourceFile(
		filename,
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	let found = false;
	function visit(node) {
		if (
			(ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
			ts.isIdentifier(node.tagName) &&
			node.tagName.text === "select"
		)
			found = true;
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}

function hasGreenLiteral(source) {
	const file = ts.createSourceFile(
		"control.tsx",
		source,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TSX,
	);
	let found = false;
	function visit(node) {
		if (
			(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
			GREEN.test(node.text)
		) {
			found = true;
		}
		ts.forEachChild(node, visit);
	}
	visit(file);
	return found;
}

function componentFiles(directory) {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory()) return componentFiles(file);
		return /\.[jt]sx$/.test(entry.name) && !/\.(?:test|spec)\.[jt]sx$/.test(entry.name)
			? [file]
			: [];
	});
}

export function checkDesignPolicy(root = ROOT) {
	const violations = [];
	for (const [relative, required] of Object.entries(STYLES)) {
		for (const error of inspectStylePolicy(
			readFileSync(path.join(root, relative), "utf8"),
			required,
		)) {
			violations.push(`${relative}: ${error}`);
		}
	}
	for (const file of componentFiles(path.join(root, "src"))) {
		if (hasNativeSelect(readFileSync(file, "utf8"), file)) {
			violations.push(`${path.relative(root, file)}: use AppSelect for option menus`);
		}
	}
	const shortcuts = "src/components/video-editor/ShortcutsConfigDialog.tsx";
	if (hasGreenLiteral(readFileSync(path.join(root, shortcuts), "utf8"))) {
		violations.push(`${shortcuts}: green theme literal`);
	}
	return violations;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
	const violations = checkDesignPolicy();
	if (violations.length) throw new Error(violations.join("\n"));
	console.log("Design policy: semantic control tokens and AppSelect checked");
}
