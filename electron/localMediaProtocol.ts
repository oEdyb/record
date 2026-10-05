import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";
import {
	fromKlipptMediaUrl,
	KLIPPT_MEDIA_PATH_PREFIX,
	KLIPPT_RESOURCE_PATH_PREFIX,
} from "../src/lib/localMediaUrl";

export interface LocalMediaProtocolOptions {
	rendererDist: string;
	resourceRoot: string;
	resolveMediaPath: (filePath: string) => string | null;
	allowedCorsOrigins?: readonly string[];
}

const MIME_TYPES: Readonly<Record<string, string>> = {
	".aac": "audio/aac",
	".avi": "video/x-msvideo",
	".flac": "audio/flac",
	".m4a": "audio/mp4",
	".m4v": "video/mp4",
	".mkv": "video/x-matroska",
	".mov": "video/quicktime",
	".mp3": "audio/mpeg",
	".mp4": "video/mp4",
	".ogg": "audio/ogg",
	".ts": "video/mp2t",
	".wav": "audio/wav",
	".webm": "video/webm",
	".wmv": "video/x-ms-wmv",
};

export function registerKlipptScheme(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: "klippt",
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				stream: true,
				codeCache: true,
				corsEnabled: true,
			},
		},
	]);
}

function isPathInside(filePath: string, rootPath: string): boolean {
	const relative = path.relative(rootPath, filePath);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function resolveContainedPath(
	rootPath: string,
	relativePath: string,
): Promise<string | null> {
	const candidate = path.resolve(rootPath, `.${path.sep}${relativePath}`);
	if (!isPathInside(candidate, path.resolve(rootPath))) return null;
	try {
		const [realRoot, realCandidate] = await Promise.all([
			fs.realpath(rootPath),
			fs.realpath(candidate),
		]);
		return isPathInside(realCandidate, realRoot) ? realCandidate : null;
	} catch {
		return null;
	}
}

interface ByteRange {
	start: number;
	end: number;
}

export function parseByteRange(header: string | null, size: number): ByteRange | null | "invalid" {
	if (!header) return null;
	const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!match || size <= 0) return "invalid";
	const [, startText, endText] = match;
	if (!startText && !endText) return "invalid";
	if (!startText) {
		const suffixLength = Number(endText);
		if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
		return { start: Math.max(0, size - suffixLength), end: size - 1 };
	}
	const start = Number(startText);
	const requestedEnd = endText ? Number(endText) : size - 1;
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(requestedEnd) ||
		start < 0 ||
		start >= size ||
		requestedEnd < start
	) {
		return "invalid";
	}
	return { start, end: Math.min(requestedEnd, size - 1) };
}

function permittedCorsOrigin(
	request: Request,
	allowedOrigins: readonly string[] = [],
): string | null {
	const origin = request.headers.get("origin");
	return origin && allowedOrigins.includes(origin) ? origin : null;
}

async function streamFile(
	request: Request,
	filePath: string,
	allowedCorsOrigins: readonly string[] = [],
): Promise<Response> {
	const stat = await fs.stat(filePath).catch(() => null);
	if (!stat?.isFile()) return new Response("Not found", { status: 404 });
	const range = parseByteRange(request.headers.get("range"), stat.size);
	if (range === "invalid") {
		return new Response(null, {
			status: 416,
			headers: { "Accept-Ranges": "bytes", "Content-Range": `bytes */${stat.size}` },
		});
	}
	const start = range?.start ?? 0;
	const end = range?.end ?? Math.max(0, stat.size - 1);
	const contentLength = stat.size === 0 ? 0 : end - start + 1;
	const headers = new Headers({
		"Accept-Ranges": "bytes",
		"Content-Length": String(contentLength),
		"Content-Type": MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream",
	});
	const corsOrigin = permittedCorsOrigin(request, allowedCorsOrigins);
	if (corsOrigin) {
		headers.set("Access-Control-Allow-Origin", corsOrigin);
		headers.set("Vary", "Origin");
	}
	if (range) headers.set("Content-Range", `bytes ${start}-${end}/${stat.size}`);
	if (request.method === "HEAD" || stat.size === 0) {
		return new Response(null, { status: range ? 206 : 200, headers });
	}
	const body = Readable.toWeb(createReadStream(filePath, { start, end }));
	return new Response(body as ReadableStream, { status: range ? 206 : 200, headers });
}

export function createKlipptProtocolHandler(
	options: LocalMediaProtocolOptions,
): (request: Request) => Promise<Response> {
	return async (request) => {
		try {
			const url = new URL(request.url);
			if (url.protocol !== "klippt:" || url.host !== "app") {
				return new Response("Forbidden", { status: 403 });
			}
			if (request.method === "OPTIONS") {
				const corsOrigin = permittedCorsOrigin(request, options.allowedCorsOrigins);
				return corsOrigin
					? new Response(null, {
							status: 204,
							headers: {
								"Access-Control-Allow-Headers": "Range",
								"Access-Control-Allow-Methods": "GET, HEAD",
								"Access-Control-Allow-Origin": corsOrigin,
								Vary: "Origin",
							},
						})
					: new Response("Forbidden", { status: 403 });
			}
			if (!["GET", "HEAD"].includes(request.method)) {
				return new Response("Forbidden", { status: 403 });
			}
			if (url.pathname.startsWith(KLIPPT_MEDIA_PATH_PREFIX)) {
				const requestedPath = fromKlipptMediaUrl(url.toString());
				if (!requestedPath) return new Response("Bad request", { status: 400 });
				const realPath = await fs.realpath(requestedPath).catch(() => null);
				const approvedPath = realPath ? options.resolveMediaPath(realPath) : null;
				return approvedPath
					? streamFile(request, approvedPath, options.allowedCorsOrigins)
					: new Response("Forbidden", { status: 403 });
			}
			if (url.pathname.startsWith(KLIPPT_RESOURCE_PATH_PREFIX)) {
				const resourcePath = await resolveContainedPath(
					options.resourceRoot,
					decodeURIComponent(url.pathname.slice(KLIPPT_RESOURCE_PATH_PREFIX.length)),
				);
				return resourcePath
					? net.fetch(pathToFileURL(resourcePath).toString())
					: new Response("Not found", { status: 404 });
			}
			const bundlePath = await resolveContainedPath(
				options.rendererDist,
				decodeURIComponent(url.pathname === "/" ? "index.html" : url.pathname.slice(1)),
			);
			return bundlePath
				? net.fetch(pathToFileURL(bundlePath).toString())
				: new Response("Not found", { status: 404 });
		} catch {
			return new Response("Bad request", { status: 400 });
		}
	};
}

export function installKlipptProtocol(options: LocalMediaProtocolOptions): void {
	protocol.handle("klippt", createKlipptProtocolHandler(options));
}
