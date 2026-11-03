// @vitest-environment jsdom
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStudioPillNotice } from "./useStudioPillNotice";

function toastElement(type: string) {
	const element = document.createElement("li");
	element.setAttribute("data-sonner-toast", "");
	element.setAttribute("data-type", type);
	document.body.append(element);
	return element;
}

describe("useStudioPillNotice", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("reports an error toast until it is removed, and ignores plain ones", async () => {
		const notice = vi.fn();
		window.electronAPI = { studioPillNotice: notice } as unknown as typeof window.electronAPI;
		renderHook(() => useStudioPillNotice());
		toastElement("success");
		await new Promise((resolve) => setTimeout(resolve));
		expect(notice).not.toHaveBeenCalled();

		const alert = toastElement("error");
		await waitFor(() => expect(notice).toHaveBeenLastCalledWith(true));
		alert.setAttribute("data-removed", "true");
		await waitFor(() => expect(notice).toHaveBeenLastCalledWith(false));
	});
});
