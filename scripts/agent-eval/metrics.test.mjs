import { expect, it } from "vitest";
import { extractTokens } from "./metrics.mjs";

it.each(["41,638", "41'638", "41’638", "41638"])("reads complete token counts: %s", (count) => {
	expect(extractTokens(`tokens used\n${count}`)).toBe(41638);
});
it("does not invent unavailable usage", () => expect(extractTokens("done")).toBeNull());
