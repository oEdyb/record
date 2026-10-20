import { describe, expect, it } from "vitest";
import { ipcErrorMessage } from "./ipcErrorMessage";

describe("ipcErrorMessage", () => {
	it("removes Electron's remote-method wrapper", () => {
		const error = new Error(
			"Error invoking remote method 'entitlement:activate': Error: This license is not active.",
		);
		expect(ipcErrorMessage(error)).toBe("This license is not active.");
	});

	it("removes a typed error name inside the wrapper", () => {
		const error = new Error(
			"Error invoking remote method 'entitlement:activate': TypeError: License key must be a string.",
		);
		expect(ipcErrorMessage(error)).toBe("License key must be a string.");
	});

	it("keeps a plain message and non-Error values", () => {
		expect(ipcErrorMessage(new Error("Enter a license key."))).toBe("Enter a license key.");
		expect(ipcErrorMessage("offline")).toBe("offline");
	});
});
