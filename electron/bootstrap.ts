import { enableCompileCache } from "node:module";
import path from "node:path";
import { app } from "electron";
import { APP_DISPLAY_NAME } from "../src/lib/brand";
import { registerKlipptScheme } from "./localMediaProtocol";

// V8 code cache for the bundles imported below (Node 22.8+, never throws). The first launch
// after an update compiles and writes it; later launches skip compiling the main bundle.
enableCompileCache();

registerKlipptScheme();

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
