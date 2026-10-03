import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DEADLINE_MS = 15_000;
const MAX_CONNECTIONS = 16;
const MAX_HANDLERS = 4;

export interface AgentBrokerRequest {
	api_version: "1.0";
	request_id: string;
	command: string;
	input: Record<string, unknown>;
}

function parseRequest(raw: string): AgentBrokerRequest {
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Invalid request");
	const record = value as Record<string, unknown>;
	if (
		record.api_version !== "1.0" ||
		typeof record.request_id !== "string" ||
		record.request_id.length < 1 ||
		record.request_id.length > 256 ||
		typeof record.command !== "string" ||
		record.command.length > 100 ||
		!record.input ||
		typeof record.input !== "object" ||
		Array.isArray(record.input) ||
		Object.keys(record).some(
			(key) => !["api_version", "request_id", "command", "input"].includes(key),
		)
	) {
		throw new Error("Invalid request envelope or incompatible API version");
	}
	return record as unknown as AgentBrokerRequest;
}

/** Caller must already hold the app-wide single-owner lock before opting in.
 * A refused connect alone is not proof of exclusive ownership. */
async function recoverStaleEndpoint(socketPath: string) {
	let before;
	try {
		before = await fs.lstat(socketPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (!before.isSocket() || (process.getuid && before.uid !== process.getuid()))
		throw new Error("Refusing to replace a non-owned socket endpoint");
	await new Promise<void>((resolve, reject) => {
		const probe = net.createConnection(socketPath);
		const deadline = setTimeout(() => probe.destroy(new Error("Endpoint probe timed out")), 1000);
		probe.once("connect", () => {
			probe.destroy();
			reject(new Error("Agent broker already active"));
		});
		probe.once("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED") resolve();
			else reject(error);
		});
		probe.once("close", () => clearTimeout(deadline));
	});
	const after = await fs.lstat(socketPath);
	if (before.dev !== after.dev || before.ino !== after.ino || !after.isSocket())
		throw new Error("Agent endpoint changed during recovery");
	await fs.unlink(socketPath);
}

/** Thin local transport. Handler owns authorization, project state and transaction rules.
 * One request per connection; no network port, arbitrary eval, or media in diagnostics.
 */
export async function startAgentBroker(
	directory: string,
	handler: (request: AgentBrokerRequest) => Promise<unknown>,
	options: { exclusiveOwner?: boolean } = {},
) {
	await fs.mkdir(directory, { recursive: true, mode: 0o700 });
	const stat = await fs.lstat(directory);
	if (
		!stat.isDirectory() ||
		stat.isSymbolicLink() ||
		(stat.mode & 0o077) !== 0 ||
		(process.getuid && stat.uid !== process.getuid())
	) {
		throw new Error("Agent broker requires a private owned directory");
	}
	const socketPath = path.join(await fs.realpath(directory), "agent.sock");
	if (Buffer.byteLength(socketPath) > 100) throw new Error("Agent broker socket path is too long");
	// The GUI single-instance lock provides cross-process exclusivity; default callers
	// cannot reclaim endpoints. The probe additionally protects a live old broker.
	if (options.exclusiveOwner) await recoverStaleEndpoint(socketPath);
	const sockets = new Set<net.Socket>();
	let handlers = 0;
	let closing = false;
	const server = net.createServer((socket) => {
		if (closing || sockets.size >= MAX_CONNECTIONS) {
			socket.destroy();
			return;
		}
		sockets.add(socket);
		const deadline = setTimeout(() => socket.destroy(), DEADLINE_MS);
		socket.once("close", () => {
			clearTimeout(deadline);
			sockets.delete(socket);
		});
		let bytes = Buffer.alloc(0);
		let dispatched = false;
		socket.on("error", () => {
			/* Disconnected clients do not affect committed work. */
		});
		socket.on("data", (chunk: Buffer) => {
			if (dispatched) return;
			if (bytes.length + chunk.length > MAX_REQUEST_BYTES) {
				socket.destroy();
				return;
			}
			bytes = Buffer.concat([bytes, chunk]);
			const newline = bytes.indexOf(10);
			if (newline < 0) return;
			dispatched = true;
			void (async () => {
				let request: AgentBrokerRequest | undefined;
				let started = false;
				try {
					if (
						bytes
							.subarray(newline + 1)
							.toString()
							.trim()
					)
						throw new Error("One request per connection");
					request = parseRequest(bytes.subarray(0, newline).toString("utf8"));
					bytes = Buffer.alloc(0);
					if (handlers >= MAX_HANDLERS) throw new Error("Broker busy");
					handlers++;
					started = true;
					const result = await handler(request);
					const body = `${JSON.stringify(result)}\n`;
					if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES)
						throw new Error("Response exceeds transport limit");
					socket.end(body);
				} catch {
					socket.end(
						`${JSON.stringify({ api_version: "1.0", request_id: request?.request_id, status: started ? "unknown" : "failed", error: { code: started ? "BROKER_OUTCOME_UNKNOWN" : "BROKER_REQUEST_FAILED", recovery_required: started } })}\n`,
					);
				} finally {
					if (started) handlers--;
				}
			})();
		});
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});
	return {
		socketPath,
		close: () =>
			new Promise<void>((resolve, reject) => {
				closing = true;
				server.close((error) => (error ? reject(error) : resolve()));
				for (const socket of sockets) socket.destroy();
			}),
	};
}

export async function requestAgentBroker(
	socketPath: string,
	request: AgentBrokerRequest,
): Promise<unknown> {
	const body = `${JSON.stringify(request)}\n`;
	if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new Error("Agent request is too large");
	return new Promise((resolve, reject) => {
		const socket = net.createConnection(socketPath);
		let bytes = Buffer.alloc(0);
		let complete = false;
		const deadline = setTimeout(
			() =>
				socket.destroy(
					new Error(
						`Broker timeout; recover request ${request.request_id} before retrying a write`,
					),
				),
			DEADLINE_MS,
		);
		socket.once("connect", () => socket.write(body));
		socket.once("error", reject);
		socket.on("data", (chunk: Buffer) => {
			bytes = Buffer.concat([bytes, chunk]);
			if (bytes.length > MAX_RESPONSE_BYTES) {
				socket.destroy(new Error("Broker response is too large"));
				return;
			}
			const newline = bytes.indexOf(10);
			if (newline < 0) return;
			try {
				complete = true;
				resolve(JSON.parse(bytes.subarray(0, newline).toString("utf8")));
			} catch (error) {
				reject(error);
			}
			socket.destroy();
		});
		socket.once("close", () => {
			clearTimeout(deadline);
			if (!complete)
				reject(new Error("Broker connection closed before a result; commit state is unknown"));
		});
	});
}
