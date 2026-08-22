import path from "node:path";
import { app } from "electron";
import { APP_DISPLAY_NAME } from "../src/lib/brand";

// The package can adopt the Klippt display name without making existing projects,
// recordings, permissions, and preferences appear to disappear. Keep the current
// data directory until a later migration copies and verifies it before switching.
// Tests and isolated CLI runs can still request their own data directory.
app.setPath(
	"userData",
	process.env.ELECTRON_USER_DATA_DIR?.trim() || path.join(app.getPath("appData"), "openscreen"),
);
app.setName(APP_DISPLAY_NAME);

await import("./main");
