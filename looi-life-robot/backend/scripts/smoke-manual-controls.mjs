import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(scriptDirectory, "..", "..");
const [html, app, gimbalController] = await Promise.all([
  readFile(resolve(projectRoot, "frontend", "index.html"), "utf8"),
  readFile(resolve(projectRoot, "frontend", "js", "app.js"), "utf8"),
  readFile(resolve(projectRoot, "frontend", "js", "robot", "gimbalBehaviorController.js"), "utf8")
]);

assert.match(html, /id="manualControlDock"/);
assert.match(html, /id="manualControlCollapseButton"/);
assert.match(html, /id="looiVisionCollapseButton"/);
assert.match(html, /id="controlModeButton"/);
assert.match(html, /data-manual-drive="forward"/);
assert.match(html, /data-manual-drive="backward"/);
assert.match(html, /data-manual-gimbal="up"/);
assert.match(html, /data-manual-gimbal="down"/);
assert.doesNotMatch(html, /id="gimbalYawSlider"|id="gimbalPitchSlider"/);
assert.doesNotMatch(html, /id="idleScenarioTestList"|Test Animations/);

const controlModeListeners = app.match(/ui\.controlModeButton\?\.addEventListener\("click"/g) ?? [];
assert.equal(controlModeListeners.length, 1, "control-mode button must have one listener");
assert.match(app, /localMotionArmed: nextMode === "agent"/);
assert.match(app, /if \(brainPolicy\.controlMode !== "manual"\) \{\s*log\("Switch to Manual control before driving/);
assert.match(app, /left: \{ linear: 0, angular: -speed \}/);
assert.match(app, /right: \{ linear: 0, angular: speed \}/);
assert.match(gimbalController, /function mapUserGimbalDirection\(direction\) \{ return direction; \}/);
assert.doesNotMatch(app, /toggleMicrophoneButton|resetMicrophoneButton|clearMicrophoneCacheButton/);

console.log(JSON.stringify({ ok: true, controlModeListeners: controlModeListeners.length }));
