import { dialog, type WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFontValidationError } from "../../src/lib/localFont";
import { readLocalFontDataUrl } from "../media/localFontFile";
import { chooseLocalFont } from "./localFont";

vi.mock("electron", () => ({
	BrowserWindow: { fromWebContents: () => null },
	dialog: { showOpenDialog: vi.fn() },
}));
vi.mock("../media/localFontFile", () => ({ readLocalFontDataUrl: vi.fn() }));

const sender = {} as WebContents;
const LOCAL_TTF_DATA_URL = `data:font/ttf;base64,${Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64")}`;
const request = {
	family: "Roboto",
	style: "italic" as const,
	weight: 400,
	styleLabel: "Kursiv",
};

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(readLocalFontDataUrl).mockResolvedValue(LOCAL_TTF_DATA_URL);
});

describe("chooseLocalFont", () => {
	it("names the exact variation and permits one supported font file", async () => {
		vi.mocked(dialog.showOpenDialog).mockResolvedValue({
			canceled: false,
			filePaths: ["/tmp/Roboto-Italic.ttf"],
		});

		const result = await chooseLocalFont(request, sender);

		expect(dialog.showOpenDialog).toHaveBeenCalledWith({
			title: "Roboto · Kursiv 400",
			filters: [{ name: "TTF, OTF, WOFF, WOFF2", extensions: ["ttf", "otf", "woff", "woff2"] }],
			properties: ["openFile"],
		});
		expect(readLocalFontDataUrl).toHaveBeenCalledWith("/tmp/Roboto-Italic.ttf");
		expect(result).toEqual({
			success: true,
			canceled: false,
			dataUrl: LOCAL_TTF_DATA_URL,
		});
		expect(result).not.toHaveProperty("path");
	});

	it("returns cancellation without reading or changing anything", async () => {
		vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });

		await expect(chooseLocalFont(request, sender)).resolves.toEqual({
			success: false,
			canceled: true,
		});
		expect(readLocalFontDataUrl).not.toHaveBeenCalled();
	});

	it("maps validation failures to a typed local import error", async () => {
		vi.mocked(dialog.showOpenDialog).mockResolvedValue({
			canceled: false,
			filePaths: ["/tmp/not-font.woff2"],
		});
		vi.mocked(readLocalFontDataUrl).mockRejectedValue(
			new LocalFontValidationError("invalid-font", "invalid font"),
		);

		await expect(chooseLocalFont(request, sender)).resolves.toEqual({
			success: false,
			canceled: false,
			error: "invalid-font",
		});
	});

	it("rejects malformed requests before opening a dialog", async () => {
		await expect(chooseLocalFont({ ...request, weight: 0 }, sender)).resolves.toEqual({
			success: false,
			canceled: false,
			error: "invalid-request",
		});
		expect(dialog.showOpenDialog).not.toHaveBeenCalled();
	});
});
