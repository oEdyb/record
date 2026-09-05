import { describe, expect, it } from "vitest";
import { AudioPeaksCache } from "./audioPeaksCache";

describe("waveform cache retention", () => {
	it("evicts the least recently used idle result, including cached failures", () => {
		const cache = new AudioPeaksCache(2);
		cache.set("a", null);
		cache.set("b", null);
		cache.retain("a")();
		cache.set("c", null);
		expect(cache.has("a")).toBe(true);
		expect(cache.has("b")).toBe(false);
		expect(cache.has("c")).toBe(true);
	});

	it("keeps active values over the byte budget until the final reader releases", () => {
		const cache = new AudioPeaksCache(10, 4);
		const first = cache.retain("active");
		const second = cache.retain("active");
		const peaks = new Float32Array([1, 2]);
		cache.set("active", peaks);
		cache.set("idle", new Float32Array([3]));
		expect(cache.has("idle")).toBe(false);
		first();
		first(); // release is idempotent
		expect(cache.get("active")).toBe(peaks);
		second();
		expect(cache.has("active")).toBe(false);
		expect(peaks).toEqual(new Float32Array([1, 2]));
	});

	it("accounts for replacement bytes and pins a pending decode before it completes", () => {
		const cache = new AudioPeaksCache(1, 8);
		const release = cache.retain("pending");
		cache.set("pending", new Float32Array([1, 2]));
		cache.set("pending", new Float32Array([1]));
		release();
		expect(cache.has("pending")).toBe(true);
		cache.set("next", null);
		expect(cache.has("pending")).toBe(false);
	});
});
