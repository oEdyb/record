import type { Writable } from "node:stream";

export async function flushCliOutput(...streams: Writable[]): Promise<void> {
	await Promise.all(
		streams.map(
			(stream) =>
				new Promise<void>((resolve) => {
					if (stream.destroyed || !stream.writable) {
						resolve();
						return;
					}
					try {
						// A queued write callback runs after preceding pipe writes, even below the high-water mark.
						stream.write("", () => resolve());
					} catch {
						resolve();
					}
				}),
		),
	);
}
