// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { I18nProvider } from "@/contexts/I18nContext";
import {
	InspectorActionButton,
	InspectorPane,
	InspectorRow,
	InspectorSegmentedControl,
	InspectorSlider,
	InspectorSwitch,
	InspectorTabs,
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
		expect(screen.getByRole("textbox", { name: "Shadow (%)" })).toHaveValue("21");

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

function NumericFixture({
	onChange,
	onCommit,
}: {
	onChange: (value: number) => void;
	onCommit: (value: number) => void;
}) {
	const [value, setValue] = useState(20);
	return (
		<I18nProvider>
			<InspectorSlider
				label="Amount"
				value={value}
				min={0}
				max={100}
				onChange={(next) => {
					onChange(next);
					setValue(next);
				}}
				onCommit={() => onCommit(value)}
			/>
		</I18nProvider>
	);
}

describe("inspector numeric entry", () => {
	it("keeps typing local and commits exact decimal comma input once with the latest value", () => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		render(<NumericFixture onChange={onChange} onCommit={onCommit} />);
		const input = screen.getByRole("textbox", { name: "Amount" });
		fireEvent.change(input, { target: { value: " 24,5 " } });
		expect(onChange).not.toHaveBeenCalled();
		expect(screen.getByRole("slider")).toHaveAttribute("aria-valuenow", "20");
		fireEvent.keyDown(input, { key: "Enter" });
		fireEvent.blur(input);
		expect(onChange).toHaveBeenCalledExactlyOnceWith(24.5);
		expect(onCommit).toHaveBeenCalledExactlyOnceWith(24.5);
		expect(input).toHaveValue("24.5");
	});

	it.each([
		"",
		"101",
		"-1",
		"Infinity",
		"NaN",
		"1.2.3",
		"1,2.3",
		"1 2",
		"0x10",
		"1,000",
	])("retains invalid draft %j without changing the document", (draft) => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		render(<NumericFixture onChange={onChange} onCommit={onCommit} />);
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: draft } });
		fireEvent.blur(input);
		expect(input).toHaveValue(draft);
		expect(input).toHaveAttribute("aria-invalid", "true");
		expect(input).toHaveAttribute("aria-describedby", screen.getByRole("alert").id);
		expect(onChange).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
		fireEvent.keyDown(input, { key: "Escape" });
		fireEvent.blur(input);
		expect(input).toHaveValue("20");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("commits on blur and does not commit equivalent or abandoned input", () => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		render(<NumericFixture onChange={onChange} onCommit={onCommit} />);
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "020.0" } });
		fireEvent.blur(input);
		expect(onCommit).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "75" } });
		fireEvent.keyDown(input, { key: "Escape" });
		fireEvent.blur(input);
		expect(onChange).not.toHaveBeenCalled();
		fireEvent.change(input, { target: { value: "100" } });
		fireEvent.blur(input);
		expect(onCommit).toHaveBeenCalledExactlyOnceWith(100);
	});

	it.each(["disabled", "readOnly"] as const)("blocks numeric and slider edits when %s", (mode) => {
		const onChange = vi.fn();
		const onCommit = vi.fn();
		render(
			<InspectorSlider
				label="Locked"
				value={20}
				min={0}
				max={100}
				{...{ [mode]: true }}
				onChange={onChange}
				onCommit={onCommit}
			/>,
		);
		const input = screen.getByRole("textbox");
		expect(input).toHaveAttribute(mode === "disabled" ? "disabled" : "readonly");
		fireEvent.change(input, { target: { value: "30" } });
		fireEvent.blur(input);
		fireEvent.keyDown(screen.getByRole("slider"), { key: "ArrowRight" });
		expect(onChange).not.toHaveBeenCalled();
		expect(onCommit).not.toHaveBeenCalled();
	});

	it("formats generated floating point noise without losing intentional precision", () => {
		const props = { label: "Zoom", min: 0, max: 100, onChange: vi.fn(), onCommit: vi.fn() };
		const { rerender } = render(
			<InspectorSlider {...props} value={1.4000000000000001} decimals={2} />,
		);
		expect(screen.getByRole("textbox")).toHaveValue("1.40");
		rerender(<InspectorSlider {...props} value={24.5} decimals={0} />);
		expect(screen.getByRole("textbox")).toHaveValue("24.5");
	});

	it("replaces an invalid draft when an external value changes and never reapplies it on blur", () => {
		const props = { label: "Amount", min: 0, max: 100, onChange: vi.fn(), onCommit: vi.fn() };
		const { rerender } = render(
			<I18nProvider>
				<InspectorSlider {...props} value={20} />
			</I18nProvider>,
		);
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "101" } });
		fireEvent.keyDown(input, { key: "Enter" });
		expect(input).toHaveAttribute("aria-invalid", "true");
		rerender(
			<I18nProvider>
				<InspectorSlider {...props} value={30} />
			</I18nProvider>,
		);
		expect(input).toHaveValue("30");
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		fireEvent.blur(input);
		expect(props.onChange).not.toHaveBeenCalled();
		expect(props.onCommit).not.toHaveBeenCalled();
	});

	it("replaces a valid pending draft when an external value changes", () => {
		const props = { label: "Amount", min: 0, max: 100, onChange: vi.fn(), onCommit: vi.fn() };
		const { rerender } = render(<InspectorSlider {...props} value={20} />);
		const input = screen.getByRole("textbox");
		fireEvent.change(input, { target: { value: "75" } });
		rerender(<InspectorSlider {...props} value={30} />);
		expect(input).toHaveValue("30");
		fireEvent.blur(input);
		expect(props.onChange).not.toHaveBeenCalled();
		expect(props.onCommit).not.toHaveBeenCalled();
	});

	it("shows no text field when the value is hidden", () => {
		render(
			<InspectorSlider
				label="Amount"
				value={20}
				min={0}
				max={100}
				showValue={false}
				onChange={vi.fn()}
				onCommit={vi.fn()}
			/>,
		);
		expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
	});
});

it("switches inspector tasks with the keyboard and preserves drafts in hidden sections", () => {
	render(
		<InspectorTabs
			label="Layout"
			items={[
				{
					id: "canvas",
					label: "Canvas",
					content: <input aria-label="Width draft" defaultValue="1920" />,
				},
				{ id: "camera", label: "Camera", content: <button type="button">Camera size</button> },
			]}
		/>,
	);
	const input = screen.getByRole("textbox", { name: "Width draft" });
	fireEvent.change(input, { target: { value: "123" } });
	const canvas = screen.getByRole("tab", { name: "Canvas" });
	act(() => canvas.focus());
	fireEvent.keyDown(canvas, { key: "ArrowRight" });
	// Roving focus activates the next tab on focus.
	fireEvent.focus(screen.getByRole("tab", { name: "Camera" }));
	expect(screen.queryByRole("textbox", { name: "Width draft" })).not.toBeInTheDocument();
	expect(screen.getByRole("button", { name: "Camera size" })).toBeVisible();
	fireEvent.mouseDown(canvas, { button: 0, ctrlKey: false });
	expect(screen.getByRole("textbox", { name: "Width draft" })).toHaveValue("123");
	expect(screen.queryByRole("button", { name: "Camera size" })).not.toBeInTheDocument();
});
