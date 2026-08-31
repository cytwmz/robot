import assert from "node:assert/strict";
import fs from "node:fs";
import { CameraInput } from "../../frontend/js/perception/camera.js";

const cameraSource = fs.readFileSync(
  new URL("../../frontend/js/perception/camera.js", import.meta.url),
  "utf8"
);
assert.match(cameraSource, /@mediapipe\/tasks-vision/);
assert.match(cameraSource, /detectForVideo/);
assert.match(cameraSource, /delegate: "CPU"/);

const logs = [];
const statusUpdates = [];
const observations = [];
const errors = [];

const camera = new CameraInput({
  logger: (message, level = "info") => logs.push({ level, message })
});
camera.onStatus((status) => statusUpdates.push(status));
camera.onObservation((observation) => observations.push(observation));
camera.onError((message) => errors.push(message));

assert.equal(camera.isSupported(), false);
assert.equal(camera.isRunning(), false);

const initialStatus = camera.getCameraStatus();
assert.equal(typeof initialStatus, "object");
assert.equal(initialStatus.supported, false);
assert.equal(initialStatus.running, false);
assert.equal(initialStatus.visionSupported.faceDetector, false);
assert.equal(initialStatus.visionSupported.fallbackLoading, true);

const startResult = await camera.startCamera({ facingMode: "user" });
assert.equal(startResult.ok, false);
assert.match(startResult.error, /unavailable/i);
assert.equal(camera.isRunning(), false);

const observation = await camera.analyzeFrame();
assert.equal(observation.cameraRunning, false);
assert.equal(observation.detector, "none");

const snapshotResult = await camera.captureSnapshot({
  includeDataUrl: true,
  maxWidth: 320
});
assert.equal(snapshotResult.ok, false);
assert.match(snapshotResult.error, /not running/i);

const stopResult = await camera.stopCamera();
assert.equal(stopResult.ok, true);
assert.equal(camera.getCameraStatus().running, false);

console.log(
  JSON.stringify({
    ok: true,
    supported: camera.isSupported(),
    statusUpdates: statusUpdates.length,
    observations: observations.length,
    errors: errors.length,
    logs: logs.length
  })
);
