/** A literal `%` in a saved path is not an escape; keep it instead of throwing. */
function decodeFilePath(encodedPath: string): string {
	try {
		return decodeURIComponent(encodedPath);
	} catch {
		return encodedPath.replace(/(?:%[0-9a-fA-F]{2})+/g, (escaped) => {
			try {
				return decodeURIComponent(escaped);
			} catch {
				return escaped;
			}
		});
	}
}

export function fromLegacyFileUrl(fileUrl: string): string {
	if (!/^file:\/\//i.test(fileUrl)) {
		return fileUrl;
	}

	try {
		const url = new URL(fileUrl);
		const pathname = decodeFilePath(url.pathname + url.search + url.hash);

		if (url.host && url.host !== "localhost") {
			return `//${url.host}${pathname}`;
		}

		if (/^\/[a-zA-Z]:/.test(pathname)) {
			return pathname.slice(1);
		}

		return pathname;
	} catch {
		const fallbackPath = decodeFilePath(fileUrl.replace(/^file:\/\//i, ""));
		return fallbackPath.replace(/^\/([a-zA-Z]:)/, "$1");
	}
}
