export function roundHalfEven(x: number): number {
	if (Math.abs(x % 1) === 0.5) return 2 * Math.round(x / 2);
	return Math.round(x);
}

/** x.toFixed(d) with ties going to the even digit, as Python's format does. */
export function fixed(x: number, d: number): string {
	const scaled = x * 2 ** (d + 1);
	if (Number.isInteger(scaled) && Math.abs(scaled) % 2 === 1) {
		const n = Math.floor(Math.abs(x) * 10 ** d);
		const even = n % 2 === 0 ? n : n + 1;
		return `${x < 0 ? "-" : ""}${(even / 10 ** d).toFixed(d)}`;
	}
	return x.toFixed(d);
}

const pad2 = (n: number) => String(n).padStart(2, "0");

export function clockTime(ms: number): string {
	const d = new Date(ms);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function dateClockTime(ms: number): string {
	const d = new Date(ms);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${clockTime(ms)}`;
}

export function pad(n: number): string {
	return pad2(n);
}

export function firstChars(text: string, n: number): string {
	return Array.from(text).slice(0, n).join("");
}
