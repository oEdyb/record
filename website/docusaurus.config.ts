import type { Config } from "@docusaurus/types";

const SITE_URL = "https://klippt.app";
const SITE_DESCRIPTION =
	"Klippt is a clip-native screen recorder and editor for Mac. Record clean sections, remove mistakes while recording, and return to an editable first cut.";

const ORGANIZATION_LD = {
	"@context": "https://schema.org",
	"@type": "Organization",
	"@id": `${SITE_URL}/#organization`,
	name: "Dyberg & Co AB",
	url: SITE_URL,
	email: "support@klippt.app",
};

const WEBSITE_LD = {
	"@context": "https://schema.org",
	"@type": "WebSite",
	"@id": `${SITE_URL}/#website`,
	name: "Klippt",
	url: SITE_URL,
	description: SITE_DESCRIPTION,
	inLanguage: "en",
	publisher: { "@id": `${SITE_URL}/#organization` },
};

const config: Config = {
	title: "Klippt",
	tagline: "Record clean clips. Fix everything after.",
	favicon: "img/favicon.svg",
	url: SITE_URL,
	baseUrl: "/",
	trailingSlash: true,
	organizationName: "dyberg-co",
	projectName: "klippt",
	onBrokenLinks: "throw",
	onBrokenAnchors: "throw",
	headTags: [
		{
			tagName: "script",
			attributes: { type: "application/ld+json" },
			innerHTML: JSON.stringify(ORGANIZATION_LD),
		},
		{
			tagName: "script",
			attributes: { type: "application/ld+json" },
			innerHTML: JSON.stringify(WEBSITE_LD),
		},
	],
	presets: [
		[
			"@docusaurus/preset-classic",
			{
				docs: false,
				blog: false,
				theme: { customCss: "./src/css/custom.css" },
				sitemap: {
					lastmod: "date",
					changefreq: "weekly",
					priority: 0.7,
					createSitemapItems: async ({ defaultCreateSitemapItems, ...rest }) => {
						const items = await defaultCreateSitemapItems(rest);
						return items.map((item) =>
							item.url === `${SITE_URL}/` ? { ...item, priority: 1 } : item,
						);
					},
				},
			},
		],
	],
	themeConfig: {
		metadata: [
			{ name: "description", content: SITE_DESCRIPTION },
			{
				name: "keywords",
				content:
					"Mac screen recorder, clip-native recording, pause and continue recording, separate source files, creator screen recording",
			},
			{ name: "robots", content: "index, follow, max-image-preview:large, max-snippet:-1" },
			{ property: "og:type", content: "website" },
			{ property: "og:site_name", content: "Klippt" },
		],
		colorMode: {
			defaultMode: "dark",
			disableSwitch: true,
			respectPrefersColorScheme: false,
		},
		navbar: {
			title: "Klippt",
			items: [
				{ to: "/#workflow", label: "Workflow", position: "left" },
				{ to: "/#features", label: "Features", position: "left" },
				{ href: "https://github.com/oEdyb/record", label: "GitHub", position: "left" },
				{ to: "/support/", label: "Support", position: "right" },
				{
					to: "/download/",
					label: "Download",
					position: "right",
					className: "navbar-alpha-cta",
				},
			],
		},
	} satisfies Config["themeConfig"],
};

export default config;
