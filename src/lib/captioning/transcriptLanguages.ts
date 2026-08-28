export const TRANSCRIPT_LANGUAGE_CODES = [
	"auto",
	"en",
	"sv",
	"da",
	"nl",
	"fi",
	"fr",
	"de",
	"el",
	"it",
	"es",
	"pt",
	"ro",
	"hu",
	"et",
	"lv",
	"lt",
	"mt",
	"pl",
	"cs",
	"sk",
	"sl",
	"hr",
	"bs",
	"bg",
	"be",
	"ru",
	"sr",
	"uk",
	"ja",
	"ko",
	"zh",
] as const;

export type TranscriptLanguage = (typeof TRANSCRIPT_LANGUAGE_CODES)[number];

export function isTranscriptLanguage(value: string): value is TranscriptLanguage {
	return (TRANSCRIPT_LANGUAGE_CODES as readonly string[]).includes(value);
}

export function transcriptLanguageLabel(
	language: TranscriptLanguage,
	locale: string,
	automaticLabel: string,
): string {
	if (language === "auto") return automaticLabel;
	try {
		return (
			new Intl.DisplayNames([locale], { type: "language" }).of(language) ?? language.toUpperCase()
		);
	} catch {
		return language.toUpperCase();
	}
}
