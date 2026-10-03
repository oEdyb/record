export function parseEditTime(value: string | number): number {
	if (typeof value === "number") {
		if (Number.isFinite(value) && value >= 0) return value;
	} else if (/^\d+(?:\.\d+)?$/.test(value)) {
		return parseEditTime(Number(value));
	} else if (/^\d+:[0-5]?\d(?:\.\d+)?$/.test(value)) {
		const [minutes, seconds] = value.split(":").map(Number);
		return parseEditTime(minutes * 60 + seconds);
	}
	throw new Error("Time must be nonnegative edited seconds or m:ss.s");
}

export function editTimecode(seconds: number): string {
	const milliseconds = Math.round(seconds * 1000);
	const minutes = Math.floor(milliseconds / 60_000);
	return `${minutes}:${((milliseconds % 60_000) / 1000).toFixed(3).padStart(6, "0")}`;
}
