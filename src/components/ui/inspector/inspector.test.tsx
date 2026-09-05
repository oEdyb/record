// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
	InspectorActionButton,
	InspectorPane,
	InspectorRow,
	InspectorSegmentedControl,
	InspectorSlider,
	InspectorSwitch,
	InspectorToolbar,
} from ".";

function Fixture() {
	const [enabled, setEnabled] = useState(false);
	const [value, setValue] = useState(20);
	const [mode, setMode] = useState<"fixed" | "follow">("fixed");
	return (
		<TooltipProvider delayDuration={0}>
			<InspectorPane
				title="Video effects"
				helpLabel="Help"
				helpText="Style the screen track."
				toolbar={
					<InspectorToolbar label="Effect presets">
						<span>Natural</span>
						<InspectorActionButton tone="quiet">Reset</InspectorActionButton>
					</InspectorToolbar>
				}
			>
				<InspectorRow label="Blur background">
					<InspectorSwitch label="Blur background" checked={enabled} onCheckedChange={setEnabled} />
				</InspectorRow>
				<InspectorSlider
					label="Shadow"
					value={value}
					min={0}
					max={100}
					suffix="%"
					onChange={setValue}
					onCommit={vi.fn()}
				/>
				<InspectorSegmentedControl
					label="Tracking"
					value={mode}
					options={[
						{ value: "fixed", label: "Fixed" },
						{ value: "follow", label: "Follow pointer" },
					]}
					onValueChange={setMode}
				/>
			</InspectorPane>
		</TooltipProvider>
	);
}

function CommitFixture({ onCommit }: { onCommit: () => void }) {
	const [value, setValue] = useState(20);
	return (
		<InspectorSlider
			label="Shadow"
			value={value}
			min={0}
			max={100}
			onChange={setValue}
			onCommit={onCommit}
		/>
	);
}

describe("inspector primitives", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("uses native control semantics and keeps displayed values truthful", () => {
		render(<Fixture />);

		const toggle = screen.getByRole("switch", { name: "Blur background" });
		expect(toggle).toHaveAttribute("data-state", "unchecked");
		fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("data-state", "checked");

		const slider = screen.getByRole("slider", { name: "Shadow" });
		fireEvent.keyDown(slider, { key: "ArrowRight" });
		expect(screen.getByText("21%")).toBeInTheDocument();

		fireEvent.click(screen.getByRole("radio", { name: "Follow pointer" }));
		expect(screen.getByRole("radio", { name: "Follow pointer" })).toHaveAttribute(
			"data-state",
			"on",
		);
	});

	it("opens pane help without permanent explanatory copy", () => {
		render(<Fixture />);
		expect(screen.queryByText("Style the screen track.")).not.toBeInTheDocument();
		fireEvent.click(screen.getByRole("button", { name: "Help" }));
		expect(screen.getByText("Style the screen track.")).toBeInTheDocument();
	});

	it("keeps compact pane actions in a separate labelled toolbar row", () => {
		render(<Fixture />);
		const pane = screen.getByRole("region", { name: "Video effects" });
		expect(pane).toHaveAttribute("data-has-toolbar", "true");
		expect(screen.getByRole("toolbar", { name: "Effect presets" })).toContainElement(
			screen.getByRole("button", { name: "Reset" }),
		);
	});

	it("commits a keyboard edit once when the timer and blur both run", () => {
		vi.useFakeTimers();
		const onCommit = vi.fn();
		render(<CommitFixture onCommit={onCommit} />);
		const slider = screen.getByRole("slider", { name: "Shadow" });

		fireEvent.keyDown(slider, { key: "ArrowRight" });
		act(() => vi.advanceTimersByTime(180));
		fireEvent.blur(slider);

		expect(onCommit).toHaveBeenCalledOnce();
	});

	it("commits a pending keyboard edit before the pane unmounts", () => {
		vi.useFakeTimers();
		const onCommit = vi.fn();
		const { unmount } = render(<CommitFixture onCommit={onCommit} />);

		fireEvent.keyDown(screen.getByRole("slider", { name: "Shadow" }), {
			key: "ArrowRight",
		});
		unmount();
		act(() => vi.runAllTimers());

		expect(onCommit).toHaveBeenCalledOnce();
	});

	it("does not commit again when a completed pointer gesture blurs", () => {
		const onCommit = vi.fn();
		render(<CommitFixture onCommit={onCommit} />);
		const slider = screen.getByRole("slider", { name: "Shadow" });

		fireEvent.pointerDown(slider, { button: 0, ctrlKey: false });
		fireEvent.keyDown(slider, { key: "ArrowRight" });
		fireEvent.blur(slider);

		expect(onCommit).toHaveBeenCalledOnce();
	});
});
