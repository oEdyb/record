const { app, powerSaveBlocker } = require("electron");
app.whenReady().then(async () => {
  const id = powerSaveBlocker.start("prevent-display-sleep");
  console.log("started", id, powerSaveBlocker.isStarted(id));
  await new Promise(r => setTimeout(r, 1500));
  console.log("stop", powerSaveBlocker.stop(id), powerSaveBlocker.isStarted(id));
  await new Promise(r => setTimeout(r, 1500));
  app.quit();
});
app.on("window-all-closed", () => {});
