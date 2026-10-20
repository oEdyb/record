import { app } from "electron";
import { APP_DISPLAY_NAME } from "../src/lib/brand";
import { registerKlipptScheme } from "./localMediaProtocol";
import { chooseUserDataDirectory } from "./userDataLocation";

registerKlipptScheme();

// Tests and isolated CLI runs can still request their own data directory.
app.setPath(
	"userData",
	chooseUserDataDirectory({
		appData: app.getPath("appData"),
		override: process.env.ELECTRON_USER_DATA_DIR,
	}),
);
app.setName(APP_DISPLAY_NAME);

await import("./main");
