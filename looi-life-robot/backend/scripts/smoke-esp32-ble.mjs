import assert from "node:assert/strict";
import fs from "node:fs";
import { ESP32Client } from "../../frontend/js/robot/esp32Client.js";

const SERVICE_UUID = "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0001";
const COMMAND_UUID = "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0002";
const EVENTS_UUID = "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0003";
const firmwareSource = fs.readFileSync(
  new URL("../../src/main.cpp", import.meta.url),
  "utf8"
);

assert.match(firmwareSource, /#include <BLEDevice\.h>/);
assert.match(firmwareSource, /BLEDevice::init\(BLE_DEVICE_NAME\)/);
assert.match(firmwareSource, /BLECharacteristic::PROPERTY_WRITE/);
assert.match(firmwareSource, /new BLE2902\(\)/);
assert.doesNotMatch(firmwareSource, /NimBLEDevice::init/);
assert.match(firmwareSource, new RegExp(SERVICE_UUID));
assert.match(firmwareSource, new RegExp(COMMAND_UUID));
assert.match(firmwareSource, new RegExp(EVENTS_UUID));
assert.match(firmwareSource, /HEAD_YAW_PWM_PIN = 15/);
assert.match(firmwareSource, /HEAD_PITCH_PWM_PIN = 16/);
assert.match(firmwareSource, /LEFT_WHEEL_PWM_PIN = 6/);
assert.match(firmwareSource, /RIGHT_WHEEL_PWM_PIN = 9/);
assert.match(firmwareSource, /Both axes use positional servos/);
assert.match(firmwareSource, /HEAD_PITCH_RELEASE_AFTER_MOVE = true/);
assert.match(firmwareSource, /writeServoPwm\(HEAD_PITCH_PWM_PIN, HEAD_PITCH_PWM_CHANNEL,/);
assert.match(firmwareSource, /head\["continuous_rotation"\] = false/);
assert.match(firmwareSource, /PITCH_AUTHORITY_USER_COMMAND/);
assert.match(firmwareSource, /hasPitchMovementAuthority\(JsonObjectConst root\)/);
assert.doesNotMatch(firmwareSource, /captureGimbalZero\("ble_connect"\)/);
assert.doesNotMatch(firmwareSource, /Preferences preferences|holdHeadPitchNeutral|driveHeadPitch/);
assert.match(firmwareSource, /HEAD_PITCH_RELEASE_AFTER_MOVE[\s\S]*?idleServoPwm\(HEAD_PITCH_PWM_PIN/);
assert.match(firmwareSource, /FIRMWARE_HARD_MAX_SPEED = 0\.15f/);
assert.match(firmwareSource, /DEFAULT_RUNTIME_MAX_SPEED = 0\.12f/);
assert.match(firmwareSource, /DEFAULT_MIN_PWM = 70/);

const commandWrites = [];
const eventListeners = new Set();
const deviceListeners = new Set();

const commandCharacteristic = {
  async writeValueWithoutResponse(value) {
    commandWrites.push(new Uint8Array(value));
  }
};

const eventsCharacteristic = {
  addEventListener(type, callback) {
    if (type === "characteristicvaluechanged") {
      eventListeners.add(callback);
    }
  },
  removeEventListener(type, callback) {
    if (type === "characteristicvaluechanged") {
      eventListeners.delete(callback);
    }
  },
  async startNotifications() {
    return this;
  },
  async stopNotifications() {
    return this;
  }
};

const service = {
  async getCharacteristic(uuid) {
    if (uuid === COMMAND_UUID) {
      return commandCharacteristic;
    }
    if (uuid === EVENTS_UUID) {
      return eventsCharacteristic;
    }
    throw new Error(`unexpected characteristic ${uuid}`);
  }
};

const server = {
  async getPrimaryService(uuid) {
    assert.equal(uuid, SERVICE_UUID);
    return service;
  }
};

const device = {
  name: "LOOI-S3",
  gatt: {
    connected: false,
    async connect() {
      this.connected = true;
      return server;
    },
    disconnect() {
      this.connected = false;
      for (const callback of deviceListeners) {
        callback();
      }
    }
  },
  addEventListener(type, callback) {
    if (type === "gattserverdisconnected") {
      deviceListeners.add(callback);
    }
  }
};

const bluetooth = {
  requestCount: 0,
  async requestDevice(options) {
    this.requestCount += 1;
    assert.equal(options.optionalServices[0], SERVICE_UUID);
    assert.ok(options.filters.some((filter) => filter.services?.includes(SERVICE_UUID)));
    return device;
  }
};

const logs = [];
const client = new ESP32Client({
  bluetooth,
  minDurationMs: 0,
  logger: (message, level = "info") => logs.push({ message, level })
});

let latestTelemetry = null;
let latestConfig = null;
let lastAck = null;
let disconnectError = null;

client.onTelemetry((telemetry) => {
  latestTelemetry = telemetry;
});
client.onConfig((config) => {
  latestConfig = config;
});
client.onAck((ack) => {
  lastAck = ack;
});
client.onError((error) => {
  if (error.type === "bluetooth_disconnected") {
    disconnectError = error;
  }
});

const status = await client.connect();
assert.equal(status.connected, true);
assert.equal(status.transport, "web_bluetooth");
assert.equal(bluetooth.requestCount, 1);
await waitForWrites(2);
assert.equal(commandWrites.length, 2, "connect must not reposition either gimbal axis");
assert.deepEqual(decodeWrites(commandWrites).map((payload) => payload.type), ["config_get", "ping"]);

client.sendMotion({
  linear: 0.8,
  angular: -0.8,
  durationMs: 5000,
  rampMs: 900,
  label: "test_motion"
});
await waitForWrites(3);

const motionPayload = decodeWrites(commandWrites).find((payload) => payload.type === "motion");
assert.equal(motionPayload.left_speed, 0);
assert.equal(motionPayload.right_speed, 0.12);
assert.equal(motionPayload.duration_ms, 1000);
assert.equal(motionPayload.ramp_ms, 500);
assert.equal(motionPayload.label, "test_motion");

client.sendHeadYaw({
  angle: 220,
  durationMs: 3000,
  label: "test_yaw"
});
await waitForWrites(4);

const yawPayload = decodeWrites(commandWrites).find((payload) => payload.type === "head_yaw");
assert.equal(yawPayload.angle, 180);
assert.equal(yawPayload.duration_ms, 2000);
assert.equal(yawPayload.label, "test_yaw");

assert.throws(
  () => client.sendHeadPitch({ angle: 120, label: "unauthorized_pitch" }),
  /Pitch movement requires/
);
client.sendHeadPitch({ angle: 120, label: "test_pitch", pitchAuthority: "user_command" });
await waitForWrites(5);
const pitchPayload = decodeWrites(commandWrites).find((payload) => payload.type === "head_pitch");
assert.equal(pitchPayload.angle, 90);

const writesBeforeAutomaticPitch = commandWrites.length;
assert.throws(
  () => client.sendHeadPitch({ angle: 30, label: "face_follow_pitch", pitchAuthority: "face_follow" }),
  /Pitch movement requires/
);
assert.throws(
  () => client.sendGimbalMove({ direction: "up", label: "agent_gimbal_up" }),
  /Pitch movement requires/
);
assert.ok(client.sendGimbalMove({ direction: "up", label: "user_gimbal_up", pitchAuthority: "user_command" }));
await waitForWrites(7);
assert.ok(commandWrites.length > writesBeforeAutomaticPitch);
assert.equal(
  decodeCompleteWrites(commandWrites).some((payload) => payload.label === "face_follow_pitch"),
  false
);
const automaticPitchMovePayload = decodeWrites(commandWrites).find((payload) => payload.label === "user_gimbal_up");
assert.equal(automaticPitchMovePayload.direction, "up");
assert.equal(automaticPitchMovePayload.pitch_authority, "user_command");

client.sendGimbalMove({ direction: "left", degrees: 80, durationMs: 3000, label: "test_left" });
const gimbalMovePayload = await waitForPayload(
  (payload) => payload.label === "test_left",
  "left gimbal command"
);
assert.equal(gimbalMovePayload.direction, "left");
assert.equal(gimbalMovePayload.degrees, 45);
assert.equal(gimbalMovePayload.duration_ms, 2000);
assert.equal(gimbalMovePayload.label, "test_left");
assert.throws(() => client.sendGimbalMove({ direction: "unsafe" }), /Gimbal direction/);

emitNotification('{"type":"telemetry","transport":"ble","motor_state":"stopped","config":{"max_speed":0.12}}\n');
assert.equal(latestTelemetry.motor_state, "stopped");
assert.equal(latestConfig.max_speed, 0.12);

emitNotification('{"type":"ack","cmd":"motion","accepted":true}\n');
assert.equal(lastAck.cmd, "motion");

device.gatt.disconnect();
assert.equal(client.isConnected(), false);
assert.equal(disconnectError.type, "bluetooth_disconnected");

const unsupported = new ESP32Client({ bluetooth: null });
await assert.rejects(() => unsupported.connect(), /Web Bluetooth is not available/);

console.log(JSON.stringify({
  ok: true,
  writes: commandWrites.length,
  logs: logs.length
}));

function emitNotification(text) {
  const value = new DataView(new TextEncoder().encode(text).buffer);
  for (const callback of eventListeners) {
    callback({ target: { value } });
  }
}

function decodeWrites(writes) {
  return new TextDecoder()
    .decode(concatUint8Arrays(writes))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function concatUint8Arrays(chunks) {
  const length = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function waitForWrites(count) {
  const startedAt = Date.now();
  while (commandWrites.length < count && Date.now() - startedAt < 1000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(commandWrites.length >= count, `expected at least ${count} writes`);
}

async function waitForPayload(predicate, description) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1000) {
    const payload = decodeCompleteWrites(commandWrites).find(predicate);
    if (payload) {
      return payload;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function decodeCompleteWrites(writes) {
  const text = new TextDecoder().decode(concatUint8Arrays(writes));
  const completeLines = text.split("\n");
  completeLines.pop();
  return completeLines.filter(Boolean).map((line) => JSON.parse(line));
}
