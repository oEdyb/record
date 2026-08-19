#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findClickChains, normalizeCursorPayload, selectDefaultChain } from "./policy.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));

function parseArguments(argv) {
	const options = { port: 4177, open: true };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--video") options.video = argv[++index];
		else if (argument === "--cursor") options.cursor = argv[++index];
		else if (argument === "--port") options.port = Number(argv[++index]);
		else if (argument === "--no-open") options.open = false;
		else if (argument === "--help" || argument === "-h") options.help = true;
		else throw new Error(`Unknown argument: ${argument}`);
	}
	return options;
}

function printHelp() {
	console.log(`Usage:
  node scripts/direction-lab/server.mjs --video /absolute/path/clip.mp4 [options]

Options:
  --cursor /path/clip.mp4.cursor.json  Cursor sidecar (defaults to <video>.cursor.json)
  --port 4177                         Local server port
  --no-open                           Do not open the browser automatically`);
}

function contentType(filePath) {
	if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
	if (filePath.endsWith(".mjs")) return "text/javascript; charset=utf-8";
	return "application/octet-stream";
}

async function serveFile(response, filePath) {
	const body = await fs.readFile(filePath);
	response.writeHead(200, {
		"Content-Type": contentType(filePath),
		"Content-Length": body.length,
		"Cache-Control": "no-store",
	});
	response.end(body);
}

async function serveVideo(request, response, videoPath, videoSize) {
	const range = request.headers.range;
	if (!range) {
		response.writeHead(200, {
			"Content-Type": "video/mp4",
			"Content-Length": videoSize,
			"Accept-Ranges": "bytes",
			"Cache-Control": "no-store",
		});
		createReadStream(videoPath).pipe(response);
		return;
	}

	const match = /^bytes=(\d+)-(\d*)$/.exec(range);
	if (!match) {
		response.writeHead(416, { "Content-Range": `bytes */${videoSize}` });
		response.end();
		return;
	}
	const start = Number(match[1]);
	const requestedEnd = match[2] ? Number(match[2]) : videoSize - 1;
	const end = Math.min(requestedEnd, videoSize - 1);
	if (start > end || start >= videoSize) {
		response.writeHead(416, { "Content-Range": `bytes */${videoSize}` });
		response.end();
		return;
	}
	response.writeHead(206, {
		"Content-Type": "video/mp4",
		"Content-Length": end - start + 1,
		"Content-Range": `bytes ${start}-${end}/${videoSize}`,
		"Accept-Ranges": "bytes",
		"Cache-Control": "no-store",
	});
	createReadStream(videoPath, { start, end }).pipe(response);
}

async function main() {
	const options = parseArguments(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	if (!options.video || !path.isAbsolute(options.video)) {
		throw new Error("--video must be an absolute MP4 path");
	}
	if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
		throw new Error("--port must be a valid integer port");
	}

	const videoPath = options.video;
	const cursorPath = options.cursor ?? `${videoPath}.cursor.json`;
	const [videoStat, cursorText] = await Promise.all([
		fs.stat(videoPath),
		fs.readFile(cursorPath, "utf8"),
	]);
	if (!videoStat.isFile()) throw new Error("The video path is not a file");
	const samples = normalizeCursorPayload(JSON.parse(cursorText));
	const chains = findClickChains(samples);
	const defaultChain = selectDefaultChain(chains);
	if (!defaultChain) throw new Error("The cursor sidecar has no usable click chains");

	const data = JSON.stringify({
		videoName: path.basename(videoPath),
		cursorName: path.basename(cursorPath),
		samples,
		chains,
		defaultChainId: defaultChain.id,
	});
	const sessionToken = randomBytes(18).toString("base64url");
	const basePath = `/${sessionToken}`;
	const allowedHosts = new Set([`127.0.0.1:${options.port}`, `localhost:${options.port}`]);
	const files = {
		"/": path.join(scriptDirectory, "index.html"),
		"/client.mjs": path.join(scriptDirectory, "client.mjs"),
		"/policy.mjs": path.join(scriptDirectory, "policy.mjs"),
	};

	const server = http.createServer(async (request, response) => {
		try {
			if (!allowedHosts.has(request.headers.host ?? "")) {
				response.writeHead(403);
				response.end("Invalid host");
				return;
			}
			const url = new URL(request.url ?? "/", "http://127.0.0.1");
			if (url.pathname === "/favicon.ico" || url.pathname.startsWith("/.well-known/")) {
				response.writeHead(204);
				response.end();
				return;
			}
			if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
				response.writeHead(404);
				response.end("Not found");
				return;
			}
			const route = url.pathname === basePath ? "/" : url.pathname.slice(basePath.length);
			if (route === "/data.json") {
				response.writeHead(200, {
					"Content-Type": "application/json; charset=utf-8",
					"Content-Length": Buffer.byteLength(data),
					"Cache-Control": "no-store",
				});
				response.end(data);
				return;
			}
			if (route === "/video") {
				await serveVideo(request, response, videoPath, videoStat.size);
				return;
			}
			const filePath = files[route];
			if (!filePath) {
				response.writeHead(404);
				response.end("Not found");
				return;
			}
			await serveFile(response, filePath);
		} catch (error) {
			console.error(error);
			if (!response.headersSent) response.writeHead(500);
			response.end("Direction lab server error");
		}
	});

	await new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", resolve);
	});
	const address = `http://127.0.0.1:${options.port}${basePath}/`;
	console.log(`Direction lab: ${address}`);
	console.log(`Video: ${videoPath}`);
	console.log(`Cursor: ${cursorPath}`);
	console.log(
		`Click chains: ${chains.length}; selected ${defaultChain.clicks.length} clicks from ${(defaultChain.startMs / 1_000).toFixed(3)}s to ${(defaultChain.endMs / 1_000).toFixed(3)}s`,
	);
	if (options.open) {
		const opener =
			process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
		const openerArguments = process.platform === "win32" ? ["/c", "start", "", address] : [address];
		spawn(opener, openerArguments, { detached: true, stdio: "ignore" }).unref();
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
