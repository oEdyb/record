import i18next, { type Resource } from "i18next";
import {
	DEFAULT_LOCALE,
	I18N_NAMESPACES,
	type I18nNamespace,
	LOCALE_STORAGE_KEY,
	type Locale,
} from "./config";

const modules = import.meta.glob("./locales/**/*.json", {
	query: "?url&no-inline",
	import: "default",
}) as Record<string, () => Promise<string>>;
const bundledModules = import.meta.glob(["./locales/en/*.json", "./locales/*/common.json"], {
	eager: true,
	import: "default",
}) as Record<string, unknown>;

const byLocale: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(bundledModules)) {
	const [locale, namespace] = path.replace("./locales/", "").replace(".json", "").split("/");
	if (!byLocale[locale]) byLocale[locale] = {};
	byLocale[locale][namespace] = mod;
}

const isComplete = (locale: string) =>
	I18N_NAMESPACES.every((ns) => modules[`./locales/${locale}/${ns}.json`]);
const candidates = [...new Set(Object.keys(modules).map((path) => path.split("/")[2]))].filter(
	(locale): locale is string => Boolean(locale),
);
const incomplete = candidates.filter((locale) => !isComplete(locale));
if (incomplete.length > 0) {
	console.error("[i18n] Incomplete locale folders were excluded:", incomplete.join(", "));
}

const availableLocales = candidates
	.filter(isComplete)
	.sort((a, b) => (a === DEFAULT_LOCALE ? -1 : b === DEFAULT_LOCALE ? 1 : a.localeCompare(b)));
const resources = Object.fromEntries(
	availableLocales.map((locale) => [locale, byLocale[locale] as Resource[string]]),
) as Resource;

export function getInitialLocale(): Locale {
	if (typeof localStorage === "undefined") return DEFAULT_LOCALE;
	try {
		const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
		if (stored && getAvailableLocales().includes(stored)) return stored;
	} catch {
		return DEFAULT_LOCALE;
	}
	return DEFAULT_LOCALE;
}

const initialLocale = getInitialLocale();
await i18next.init({
	lng: initialLocale,
	fallbackLng: DEFAULT_LOCALE,
	defaultNS: "common",
	partialBundledLanguages: true,
	resources,
	interpolation: { escapeValue: false },
	// A non-leaf key would otherwise render i18next's English developer message
	// ("key 'x' returned an object instead of string") straight into the UI.
	// Returning undefined keeps the old loader's behaviour: fall through to the
	// `namespace.key` marker.
	returnedObjectHandler: () => undefined,
});

const loadedLocales = new Set<Locale>([DEFAULT_LOCALE]);
const localeLoads = new Map<Locale, Promise<void>>();
let initialLocaleLoadFailure: Locale | null = null;

export function loadLocale(locale: Locale): Promise<void> {
	const target = getAvailableLocales().includes(locale) ? locale : DEFAULT_LOCALE;
	if (loadedLocales.has(target)) {
		if (initialLocaleLoadFailure === target) initialLocaleLoadFailure = null;
		return Promise.resolve();
	}
	const existing = localeLoads.get(target);
	if (existing) return existing;
	const load = Promise.all(
		I18N_NAMESPACES.map(async (namespace) => {
			const importLocale = modules[`./locales/${target}/${namespace}.json`];
			if (!importLocale) throw new Error(`Missing ${target}/${namespace} translations`);
			const url = await importLocale();
			const response = await fetch(url, { cache: "no-store" });
			if (!response.ok) {
				throw new Error(`Could not load ${target}/${namespace} translations (${response.status})`);
			}
			const resource: unknown = await response.json();
			i18next.addResourceBundle(target, namespace, resource, true, true);
		}),
	)
		.then(() => {
			loadedLocales.add(target);
			if (initialLocaleLoadFailure === target) initialLocaleLoadFailure = null;
		})
		.catch((error: unknown) => {
			localeLoads.delete(target);
			throw error;
		});
	localeLoads.set(target, load);
	return load;
}

export function getInitialLocaleLoadFailure(): Locale | null {
	return initialLocaleLoadFailure;
}

export async function loadInitialLocale(
	initial: Locale,
	load: () => Promise<void> = () => loadLocale(initial),
): Promise<void> {
	try {
		await load();
	} catch (error) {
		initialLocaleLoadFailure = initial;
		await i18next.changeLanguage(DEFAULT_LOCALE);
		console.warn(`[i18n] Could not load saved ${initial}; using English:`, error);
	}
}

if (initialLocale !== DEFAULT_LOCALE) await loadInitialLocale(initialLocale);

function tAt(
	lng: Locale,
	ns: I18nNamespace,
	key: string,
	vars?: Record<string, string | number>,
): string | undefined {
	if (!i18next.exists(key, { lng, ns })) return undefined;
	const result = i18next.t(key, { lng, ns, ...vars });
	return typeof result === "string" ? result : undefined;
}

export function getAvailableLocales(): Locale[] {
	return availableLocales.length > 0 ? availableLocales : [DEFAULT_LOCALE];
}

export function getLocaleName(locale: Locale): string {
	return tAt(locale, "common", "locale.name") ?? locale;
}

export function translate(
	locale: Locale,
	namespace: I18nNamespace,
	key: string,
	vars?: Record<string, string | number>,
): string {
	return tAt(locale, namespace, key, vars) ?? `${namespace}.${key}`;
}
