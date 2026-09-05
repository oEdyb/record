/** Completed waveform values. Mounted readers pin entries; unused values leave in LRU order. */
export class AudioPeaksCache {
	private readonly values = new Map<string, Float32Array | null>();
	private readonly readers = new Map<string, number>();
	private bytes = 0;

	constructor(
		private readonly maxEntries = 128,
		private readonly maxBytes = 8 * 1024 * 1024,
	) {}

	has(key: string): boolean {
		return this.values.has(key);
	}
	get(key: string): Float32Array | null | undefined {
		return this.values.get(key);
	}

	retain(key: string): () => void {
		this.readers.set(key, (this.readers.get(key) ?? 0) + 1);
		if (this.values.has(key)) {
			const value = this.values.get(key)!;
			this.values.delete(key);
			this.values.set(key, value);
		}
		let released = false;
		return () => {
			if (released) return;
			released = true;
			const count = (this.readers.get(key) ?? 1) - 1;
			if (count === 0) this.readers.delete(key);
			else this.readers.set(key, count);
			this.prune();
		};
	}

	set(key: string, value: Float32Array | null): void {
		this.bytes -= this.values.get(key)?.byteLength ?? 0;
		this.values.delete(key);
		this.values.set(key, value);
		this.bytes += value?.byteLength ?? 0;
		this.prune();
	}

	private prune(): void {
		for (const [key, value] of this.values) {
			if (this.values.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
			if (this.readers.has(key)) continue;
			this.values.delete(key);
			this.bytes -= value?.byteLength ?? 0;
		}
	}
}
