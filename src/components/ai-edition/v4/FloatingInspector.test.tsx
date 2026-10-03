// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

import { type Facet, FacetNavigation, ZoomScaleControl } from "./FloatingInspector";

describe("ZoomScaleControl", () => {
	it("shows and changes the scale that the renderer actually uses", async () => {
		const updateZoomScaleLive = vi.fn();
		const commitZoomScale = vi.fn();
		function Harness() {
			const [customScale, setCustomScale] = useState(1.52);
			return (
				<ZoomScaleControl
					region={{ id: "zoom-1", depth: 6, customScale }}
					tl={{
						updateZoomScaleLive: (id, next) => {
							updateZoomScaleLive(id, next);
							setCustomScale(next);
						},
						commitZoomScale,
					}}
				/>
			);
		}
		render(<Harness />);

		expect(screen.getByRole("textbox", { name: /Scale/ })).toHaveValue("1.52");
		const slider = screen.getByRole("slider");
		slider.focus();
		for (let index = 0; index < 3; index += 1) {
			fireEvent.keyDown(slider, { key: "ArrowLeft" });
		}
		expect(updateZoomScaleLive).toHaveBeenCalledWith("zoom-1", 1.4);
		fireEvent.blur(slider);
		expect(commitZoomScale).toHaveBeenCalledOnce();
	});
});

describe("FacetNavigation", () => {
	it("opens from a selection, supports keyboard travel and collapses the active pane", async () => {
		const changed = vi.fn();
		function Harness() {
			const [value, setValue] = useState<Facet | "">("");
			return (
				<FacetNavigation
					value={value}
					disabled={false}
					pauseAnalysisRunning={false}
					onValueChange={(next) => {
						changed(next);
						setValue(next);
					}}
				/>
			);
		}
		render(<Harness />);
		const effects = screen.getByRole("radio", { name: "effects.title" });
		fireEvent.click(effects);
		expect(effects).toHaveAttribute("aria-checked", "true");
		effects.focus();
		fireEvent.keyDown(effects, { key: "ArrowDown" });
		await waitFor(() => expect(screen.getByRole("radio", { name: "layout.title" })).toHaveFocus());
		fireEvent.click(effects);
		expect(changed).toHaveBeenLastCalledWith("");
		expect(effects).toHaveAttribute("aria-checked", "false");
	});
	it("does not change tools without editable media", () => {
		const changed = vi.fn();
		render(
			<FacetNavigation value="" disabled pauseAnalysisRunning={false} onValueChange={changed} />,
		);
		fireEvent.click(screen.getByRole("radio", { name: "effects.title" }));
		expect(changed).not.toHaveBeenCalled();
	});
});
