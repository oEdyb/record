import { enableCompileCache } from "node:module";
import { app } from "electron";
import { APP_DISPLAY_NAME } from "../src/lib/brand";
import { registerKlipptScheme } from "./localMediaProtocol";
import { chooseUserDataDirectory, markUserDataDirectory } from "./userDataLocation";

// V8 code cache for the bundles imported below (Node 22.8+, never throws). The first launch
// after an update compiles and writes it; later launches skip compiling the main bundle.
enableCompileCache();

registerKlipptScheme();

// Tests and isolated CLI runs can still request their own data directory.
const appData = app.getPath("appData");
const userData = chooseUserDataDirectory({
	appData,
	override: process.env.ELECTRON_USER_DATA_DIR,
});
markUserDataDirectory(userData, appData);
app.setPath("userData", userData);
app.setName(APP_DISPLAY_NAME);

await import("./main");
