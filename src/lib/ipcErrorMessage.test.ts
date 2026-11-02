import { describe, expect, it } from "vitest";
import { ipcErrorMessage } from "./ipcErrorMessage";

describe("ipcErrorMessage", () => {
	it("removes Electron's remote-method wrapper", () => {
		const error = new Error(
			"Error invoking remote method 'project:save': Error: The project file is locked.",
		);
		expect(ipcErrorMessage(error)).toBe("The project file is locked.");
	});

	it("removes a typed error name inside the wrapper", () => {
		const error = new Error(
			"Error invoking remote method 'project:save': TypeError: Project path must be a string.",
		);
		expect(ipcErrorMessage(error)).toBe("Project path must be a string.");
	});

	it("keeps a plain message and non-Error values", () => {
		expect(ipcErrorMessage(new Error("Choose a folder."))).toBe("Choose a folder.");
		expect(ipcErrorMessage("offline")).toBe("offline");
	});
});
