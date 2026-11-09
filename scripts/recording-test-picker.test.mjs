import { expect, it } from "vitest";
import { PortalPickerRequests } from "./recording-test-picker.mjs";

it("prevents an unanswered source-choice poll from selecting a newer client's monitor", () => {
	const requests = new PortalPickerRequests();
	const selected = [];
	const windowOwner = requests.start();
	const stalePoll = () => {
		if (!requests.owns(windowOwner)) return;
		selected.push("window");
		requests.transition({ type: "finish", owner: windowOwner });
	};
	const monitorOwner = requests.start();
	stalePoll();
	expect(selected).toEqual([]);
	expect(requests.transition({ type: "finish", owner: windowOwner })).toBe(false);
	expect(requests.owns(monitorOwner)).toBe(true);
	if (requests.owns(monitorOwner)) selected.push("monitor");
	expect(requests.transition({ type: "finish", owner: monitorOwner })).toBe(true);
	stalePoll();
	expect(selected).toEqual(["monitor"]);
	expect(requests.owns(monitorOwner)).toBe(false);
});
