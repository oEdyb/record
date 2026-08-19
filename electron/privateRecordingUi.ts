export interface PrivateUiPoint {
	x: number;
	y: number;
}

export interface PrivateUiRectangle extends PrivateUiPoint {
	width: number;
	height: number;
}

const MAX_PRIVATE_UI_RECTANGLES = 16;

export function normalizePrivateUiRectangles(value: unknown): PrivateUiRectangle[] {
	if (!Array.isArray(value)) return [];
	const rectangles: PrivateUiRectangle[] = [];
	for (const candidate of value) {
		if (!candidate || typeof candidate !== "object") continue;
		const rectangle = candidate as Partial<PrivateUiRectangle>;
		if (
			typeof rectangle.x !== "number" ||
			!Number.isFinite(rectangle.x) ||
			typeof rectangle.y !== "number" ||
			!Number.isFinite(rectangle.y) ||
			typeof rectangle.width !== "number" ||
			!Number.isFinite(rectangle.width) ||
			rectangle.width <= 0 ||
			typeof rectangle.height !== "number" ||
			!Number.isFinite(rectangle.height) ||
			rectangle.height <= 0
		) {
			continue;
		}
		rectangles.push({
			x: rectangle.x,
			y: rectangle.y,
			width: rectangle.width,
			height: rectangle.height,
		});
		if (rectangles.length === MAX_PRIVATE_UI_RECTANGLES) break;
	}
	return rectangles;
}

export function rectangleContainsScreenPoint(point: PrivateUiPoint, rectangle: PrivateUiRectangle) {
	return (
		point.x >= rectangle.x &&
		point.x <= rectangle.x + rectangle.width &&
		point.y >= rectangle.y &&
		point.y <= rectangle.y + rectangle.height
	);
}

export function rectanglesContainScreenPoint(
	point: PrivateUiPoint,
	rectangles: PrivateUiRectangle[],
) {
	return rectangles.some((rectangle) => rectangleContainsScreenPoint(point, rectangle));
}

export function localRectanglesContainScreenPoint(
	point: PrivateUiPoint,
	windowBounds: PrivateUiRectangle,
	localRectangles: PrivateUiRectangle[],
) {
	return localRectangles.some((rectangle) =>
		rectangleContainsScreenPoint(point, {
			x: windowBounds.x + rectangle.x,
			y: windowBounds.y + rectangle.y,
			width: rectangle.width,
			height: rectangle.height,
		}),
	);
}
