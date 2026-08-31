import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(scriptDirectory, "..", "..");
const mobileRoot = resolve(projectRoot, "frontend", "mobile-controller");
const [html, app] = await Promise.all([
  readFile(resolve(mobileRoot, "index.html"), "utf8"),
  readFile(resolve(mobileRoot, "app.js"), "utf8")
]);

assert.match(html, /id="yawSlider"[\s\S]*?max="180"/);
assert.match(html, /id="pitchSlider"[\s\S]*?max="90"/);
assert.doesNotMatch(html, /pitchNeutralSlider|Pitch stop/);
assert.match(html, /data-gimbal="up"/);
assert.match(html, /data-gimbal="left"/);
assert.match(html, /data-gimbal="down"/);
assert.match(html, /data-gimbal="right"/);
assert.match(app, /const body = new BodyBluetooth\(\)/);
assert.match(app, /left: \[speed, -speed\]/);
assert.match(app, /right: \[-speed, speed\]/);
assert.doesNotMatch(app, /gimbal_zero/);
assert.match(app, /this\.send\(\{ type: "config_get" \}\)/);
assert.match(app, /pitch_authority: "user_command"/);
assert.match(app, /type: axis === "yaw" \? "head_yaw" : "head_pitch",\s*angle:/);
assert.match(app, /const physicalDirection = normalizedDirection;/);
assert.match(app, /type: "gimbal_move",\s*direction: physicalDirection/);
assert.doesNotMatch(app, /head_pitch_neutral_us|pitchNeutralSlider/);
assert.doesNotMatch(app, /WifiBodyClient|Wi-Fi body|pulse:/);

console.log(JSON.stringify({ ok: true, transport: "web_bluetooth", gimbal: "angle" }));
