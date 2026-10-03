import { type CheckRule, finding } from "./types";

export const cameraNested: CheckRule = {
	id: "camera.nested",
	severity: "error",
	describe: "Camera emphasis entirely inside full camera on the edit.",
	fix: "removeModifier removes the nested emphasis.",
	run(context) {
		const cameras = context.authored.filter((region) => region.kind === "camera");
		const findings = cameras.flatMap((emphasis) =>
			emphasis.name !== "Camera emphasis"
				? []
				: emphasis.pieces.flatMap((piece) => {
						const full = cameras.find(
							(other) =>
								other.name === "Full camera" &&
								other.pieces.some(
									(parent) =>
										parent.clipIndex === piece.clipIndex &&
										parent.edited.startSec <= piece.edited.startSec &&
										parent.edited.endSec >= piece.edited.endSec,
								),
						);
						return full
							? [
									finding(
										cameraNested,
										piece.edited,
										piece.clip,
										`Camera emphasis (${emphasis.id}) is inside Full camera (${full.id}).`,
										[{ type: "removeModifier", args: { id: emphasis.id } }],
									),
								]
							: [];
					}),
		);
		return { findings };
	},
};
