// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { agentGuide, parseAgentCommand } from "./agentContracts";
import { applyLayoutCommand, buildLayoutOperation, layoutCommandInput } from "./agentLayout";

const base = {
	action: "set" as const,
	project_id: "project",
	scope: "clip:second",
	camera_anchor: "bottom-right" as const,
	camera_size: "M" as const,
};

describe("layout command", () => {
	it("discovers and parses named hyphenated flags", () => {
		expect(
			parseAgentCommand([
				"layout",
				"set",
				"--project_id",
				"project",
				"--scope",
				"clip:second",
				"--camera-anchor",
				"bottom-right",
				"--camera-size",
				"M",
				"--camera-shape",
				"squircle",
				"--captions",
				"off",
			]),
		).toEqual({ command: "layout", input: { ...base, camera_shape: "squircle", captions: "off" } });
		expect(agentGuide("layout").commands[0].input_schema?.additionalProperties).toBe(false);
		expect(
			agentGuide(undefined, true).commands.find((item) => item.name === "layout"),
		).toBeDefined();
	});

	it("accepts numeric camera placement and sizes", () => {
		expect(
			parseAgentCommand([
				"layout",
				"set",
				"--project_id",
				"project",
				"--scope",
				"project",
				"--camera-anchor",
				'{"cx":0.8,"cy":0.75}',
				"--camera-size",
				"34",
			]),
		).toMatchObject({ input: { camera_anchor: { cx: 0.8, cy: 0.75 }, camera_size: 34 } });
	});

	it.each([
		["--scope", "clip:"],
		["--camera-size", "81"],
		["--camera-size", "9"],
		["--camera-anchor", "corner"],
		["--camera-anchor", '{"cx":2,"cy":0.5}'],
		["--captions", "false"],
	])("rejects invalid flags %j", (...flags) => {
		expect(() =>
			parseAgentCommand([
				"layout",
				"set",
				"--project_id",
				"project",
				...(flags[0] === "--scope" ? ["--camera-size", "M"] : ["--scope", "project"]),
				...flags,
			]),
		).toThrow();
	});

	it("requires a supported action and at least one setting", () => {
		expect(() =>
			parseAgentCommand(["layout", "set", "--project_id", "p", "--scope", "project"]),
		).toThrow();
		expect(() =>
			parseAgentCommand([
				"layout",
				"clear",
				"--project_id",
				"p",
				"--scope",
				"project",
				"--camera-size",
				"M",
			]),
		).toThrow();
	});

	it("builds clip and project operations without writing a document", () => {
		expect(buildLayoutOperation(base)).toEqual({
			type: "setClipLayout",
			clipId: "second",
			layout: { cameraAnchor: "bottom-right", cameraSize: "M" },
		});
		expect(
			buildLayoutOperation(
				layoutCommandInput.parse({
					...base,
					scope: "project",
					camera_shape: "squircle",
					captions: "off",
				}),
			),
		).toEqual({
			type: "set-layout",
			settings: {
				cameraAnchor: "bottom-right",
				cameraSize: "M",
				webcamMaskShape: "squircle",
				captions: false,
			},
		});
	});

	it("uses plan/apply and reads the clip's resulting state", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ status: "completed", data: { state: { editedTimeSec: 12 } } })
			.mockResolvedValueOnce({ status: "completed", data: { planId: "plan" } })
			.mockResolvedValueOnce({ status: "completed", data: { receipt: { id: "receipt" } } })
			.mockResolvedValueOnce({
				status: "completed",
				data: {
					state: {
						editedTimeSec: 12,
						layout: { cameraSizePreset: { value: 26, layer: "clip:second" } },
					},
				},
			});
		const result = await applyLayoutCommand(
			{ ...base, request_id: "stable" },
			"generated",
			request,
		);
		expect(request.mock.calls.map(([arg]) => arg.command)).toEqual([
			"state",
			"plan",
			"apply",
			"state",
		]);
		expect(request.mock.calls[1][0].input.operations).toEqual([buildLayoutOperation(base)]);
		expect(request.mock.calls[2][0]).toMatchObject({
			request_id: "stable",
			input: { projectId: "project", planId: "plan" },
		});
		expect(request.mock.calls[3][0].input).toEqual({ projectId: "project", clipId: "second" });
		expect(result).toMatchObject({
			status: "completed",
			operation_request_id: "stable",
			commit_status: "committed",
			data: {
				receipt: { id: "receipt" },
				state: { editedTimeSec: 12, layout: { cameraSizePreset: { layer: "clip:second" } } },
			},
		});
	});

	it("keeps a failed plan guard from reaching apply", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ status: "completed", data: {} })
			.mockResolvedValueOnce({ status: "failed", error: { code: "UNSAVED_CHANGES" } });
		expect(await applyLayoutCommand(base, "generated", request)).toMatchObject({
			status: "failed",
			error: { code: "UNSAVED_CHANGES" },
		});
		expect(request).toHaveBeenCalledTimes(2);
	});

	it("does not plan a clip that has no kept state", async () => {
		const request = vi
			.fn()
			.mockResolvedValue({ status: "failed", error: { code: "NO_KEPT_CLIP" } });
		expect(await applyLayoutCommand(base, "generated", request)).toMatchObject({
			status: "failed",
		});
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("preserves the request ID when apply has an unknown outcome", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ status: "completed", data: {} })
			.mockResolvedValueOnce({ status: "completed", data: { planId: "plan" } })
			.mockRejectedValueOnce(new Error("Broker connection closed"));
		expect(await applyLayoutCommand(base, "generated", request)).toMatchObject({
			status: "recovery_required",
			operation_request_id: "generated",
			commit_status: "unknown",
		});
		expect(request).toHaveBeenCalledTimes(3);
	});

	it("reports a committed edit when the following state read fails", async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ status: "completed", data: {} })
			.mockResolvedValueOnce({ status: "completed", data: { planId: "plan" } })
			.mockResolvedValueOnce({ status: "completed", data: { receipt: { id: "receipt" } } })
			.mockRejectedValueOnce(new Error("State connection closed"));
		expect(
			await applyLayoutCommand({ ...base, scope: "project" }, "generated", request),
		).toMatchObject({
			status: "failed",
			operation_request_id: "generated",
			commit_status: "committed",
			data: { receipt: { id: "receipt" } },
		});
		expect(request.mock.calls[3][0].input).toEqual({ projectId: "project", at: 0 });
	});
});
