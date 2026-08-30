// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

import { ZoomScaleControl } from "./FloatingInspector";

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

		expect(screen.getByText("1.52×")).toBeInTheDocument();
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
