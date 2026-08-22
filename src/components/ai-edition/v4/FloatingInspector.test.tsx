// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

import { ZoomScaleControl } from "./FloatingInspector";

describe("ZoomScaleControl", () => {
	it("shows and changes the scale that the renderer actually uses", () => {
		const updateZoomScaleLive = vi.fn();
		const commitZoomScale = vi.fn();
		render(
			<ZoomScaleControl
				region={{ id: "zoom-1", depth: 6, customScale: 1.52 }}
				tl={{ updateZoomScaleLive, commitZoomScale }}
			/>,
		);

		expect(screen.getByText("1.52×")).toBeInTheDocument();
		const slider = screen.getByRole("slider");
		fireEvent.change(slider, { target: { value: "1.4" } });
		expect(updateZoomScaleLive).toHaveBeenCalledWith("zoom-1", 1.4);
		fireEvent.mouseUp(slider);
		expect(commitZoomScale).toHaveBeenCalledOnce();
	});
});
