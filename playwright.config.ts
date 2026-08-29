import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./tests/e2e",
	timeout: 120_000, // GIF encoding is CPU-bound; give it room
	retries: 0,
	reporter: "list",
	// CI installs Playwright's locked browser. Local contributors can use an
	// installed official channel without changing the shared test contract:
	// `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e`.
	use: process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : undefined,
});
