import { type CheckRule, finding } from "./types";

export const cameraOverlap: CheckRule = {
	id: "camera.overlap",
	severity: "error",
	describe: "Two camera pieces overlap on the edit.",
	run(context) {
		const pieces = context.authored
			.filter((region) => region.kind === "camera")
			.flatMap((region) => region.pieces);
		return {
			findings: pieces.flatMap((left, index) =>
				pieces.slice(index + 1).flatMap((right) => {
					const startSec = Math.max(left.edited.startSec, right.edited.startSec);
					const endSec = Math.min(left.edited.endSec, right.edited.endSec);
					return left.id !== right.id && endSec - startSec > 0.000001
						? [
								finding(
									cameraOverlap,
									{ startSec, endSec },
									left.clip,
									`${left.name} (${left.id}) overlaps ${right.name} (${right.id}).`,
								),
							]
						: [];
				}),
			),
		};
	},
};
