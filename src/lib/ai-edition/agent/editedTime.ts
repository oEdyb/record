export function parseEditedTime(value: string | number): number {
	if (typeof value === "number") {
		if (Number.isFinite(value) && value >= 0) return value;
	} else if (/^\d+(?:\.\d+)?$/.test(value)) {
		const seconds = Number(value);
		if (Number.isFinite(seconds)) return seconds;
	} else if (/^\d+:[0-5]?\d(?:\.\d+)?$/.test(value)) {
		const [minutes, seconds] = value.split(":").map(Number);
		const total = minutes * 60 + seconds;
		if (Number.isFinite(total)) return total;
	}
	throw new Error("Time must be nonnegative seconds or m:ss.s");
}

export function editedTimecode(seconds: number): string {
	const millis = Math.round(seconds * 1000);
	return `${Math.floor(millis / 60000)}:${((millis % 60000) / 1000).toFixed(3).padStart(6, "0")}`;
}
