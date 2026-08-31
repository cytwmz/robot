const BLE = Object.freeze({
  deviceName: "LOOI-S3",
  legacyDeviceName: "LOOI Body",
  service: "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0001",
  command: "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0002",
  events: "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0003",
  chunkSize: 180
});

const LIMITS = Object.freeze({
  maxSpeed: 0.12,
  durationMs: 240,
  rampMs: 70,
  gimbalDurationMs: 90,
  gimbalNudgeDegrees: 12,
  yaw: [0, 180],
  pitch: [0, 90]
});

const ui = Object.fromEntries(
  [
    "connectButton", "connectionState", "connectionLabel", "connectionDetail", "deviceName", "motionState",
    "cameraPreview", "liveFrame", "cameraButton", "cameraSwitchButton", "stopButton",
    "speedSlider", "speedValue", "leftSpeedValue", "rightSpeedValue", "latencyValue",
    "yawSlider", "yawValue", "pitchSlider", "pitchValue", "centerGimbalButton",
    "refreshButton", "telemetryMotor", "telemetryRemaining", "telemetryMaxSpeed",
    "telemetryUptime", "eventLog", "toast"
  ].map((id) => [id, document.getElementById(id)])
);

let cameraStream = null;
let facingMode = "environment";
let driveTimer = 0;
let activeDrive = null;
let gimbalTimer = 0;
let toastTimer = 0;
let logCount = 0;

class BodyBluetooth {
  constructor() {
    this.device = null;
    this.server = null;
    this.commandCharacteristic = null;
    this.eventsCharacteristic = null;
    this.connected = false;
    this.buffer = "";
    this.queue = Promise.resolve();
    this.messageId = 0;
    this.lastPingAt = 0;
    this.deviceName = "LOOI-S3";
    this.listeners = new Map();
    this.handleNotification = this.handleNotification.bind(this);
    this.handleDisconnected = this.handleDisconnected.bind(this);
  }

  on(type, callback) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(callback);
    return () => this.listeners.get(type)?.delete(callback);
  }

  emit(type, value) {
    this.listeners.get(type)?.forEach((callback) => callback(value));
  }

  async connect() {
    const availability = getBluetoothAvailability();
    if (!availability.supported) {
      throw new Error(availability.message);
    }

    this.emit("state", "connecting");
    try {
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { name: BLE.deviceName },
          { name: BLE.legacyDeviceName },
          { namePrefix: "LOOI" },
          { services: [BLE.service] }
        ],
        optionalServices: [BLE.service]
      });
      this.device.addEventListener("gattserverdisconnected", this.handleDisconnected);
      this.server = await this.device.gatt.connect();
      const service = await this.server.getPrimaryService(BLE.service);
      this.commandCharacteristic = await service.getCharacteristic(BLE.command);
      this.eventsCharacteristic = await service.getCharacteristic(BLE.events);
      this.eventsCharacteristic.addEventListener("characteristicvaluechanged", this.handleNotification);
      await this.eventsCharacteristic.startNotifications();
      this.connected = true;
      this.emit("state", "connected");
      this.emit("device", this.device.name || BLE.deviceName);
      this.log("Bluetooth connected.");
      this.send({ type: "config_get" });
      this.send({ type: "ping" });
    } catch (error) {
      this.clearConnection();
      this.emit("state", "disconnected");
      throw error;
    }
  }

  async disconnect() {
    this.connected = false;
    try {
      await this.eventsCharacteristic?.stopNotifications?.();
    } catch (error) {
      this.log(`Notification stop failed: ${error.message}`, "error");
    }
    this.eventsCharacteristic?.removeEventListener("characteristicvaluechanged", this.handleNotification);
    this.device?.gatt?.disconnect?.();
    this.clearConnection();
    this.emit("state", "disconnected");
  }

  clearConnection() {
    this.connected = false;
    this.server = null;
    this.commandCharacteristic = null;
    this.eventsCharacteristic = null;
    this.device = null;
    this.buffer = "";
  }

  isConnected() {
    return Boolean(this.connected && this.device?.gatt?.connected && this.commandCharacteristic);
  }

  send(payload) {
    if (!this.isConnected()) {
      throw new Error("ESP32 is not connected.");
    }

    const message = {
      ...payload,
      id: payload.id || `mobile-${Date.now()}-${++this.messageId}`
    };
    if (message.type === "ping") {
      this.lastPingAt = performance.now();
    }
    this.queue = this.queue
      .catch(() => {})
      .then(() => this.write(message))
      .catch((error) => {
        this.log(`Send failed: ${error.message}`, "error");
        this.emit("error", error);
      });
    return message.id;
  }

  async write(message) {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    for (let offset = 0; offset < bytes.length; offset += BLE.chunkSize) {
      const chunk = bytes.slice(offset, offset + BLE.chunkSize);
      if (this.commandCharacteristic.writeValueWithoutResponse) {
        await this.commandCharacteristic.writeValueWithoutResponse(chunk);
      } else if (this.commandCharacteristic.writeValueWithResponse) {
        await this.commandCharacteristic.writeValueWithResponse(chunk);
      } else {
        await this.commandCharacteristic.writeValue(chunk);
      }
    }
  }

  handleNotification(event) {
    this.buffer += new TextDecoder().decode(event.target.value);
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) {
        return;
      }
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) {
        continue;
      }
      try {
        this.emit("message", JSON.parse(line));
      } catch (error) {
        this.log(`Invalid device message: ${error.message}`, "error");
      }
    }
  }

  handleDisconnected() {
    const wasConnected = this.connected;
    this.clearConnection();
    this.emit("state", "disconnected");
    if (wasConnected) {
      this.emit("error", new Error("ESP32 disconnected."));
      this.log("ESP32 disconnected.", "error");
    }
  }

  log(message, level = "info") {
    this.emit("log", { message, level });
  }
}

const body = new BodyBluetooth();

body.on("state", (state) => {
  ui.connectionState.dataset.state = state;
  ui.connectionLabel.textContent = {
    connected: "Connected",
    connecting: "Connecting",
    disconnected: "Not connected",
    unsupported: "Unavailable"
  }[state] || "Not connected";
  ui.connectionDetail.textContent = {
    connected: `Connected directly to ${body.deviceName} by Bluetooth.`,
    connecting: "Choose LOOI-S3 in the browser Bluetooth dialog.",
    disconnected: "Turn on LOOI-S3, then press Connect."
  }[state] || "Turn on LOOI-S3, then press Connect.";
  ui.connectButton.querySelector("span").textContent = state === "connected" ? "Disconnect" : "Connect";
  if (state !== "connected") {
    stopDrive("link_lost", false);
  }
});

body.on("device", (name) => {
  ui.deviceName.textContent = name;
});

body.on("log", ({ message, level }) => {
  appendLog(message, level);
});

body.on("error", (error) => {
  const message = describeConnectionError(error);
  setConnectionFailure(message);
  appendLog(message, "error");
  showToast(message);
});

body.on("message", handleBodyMessage);

ui.connectButton.addEventListener("click", async () => {
  if (body.isConnected()) {
    stopDrive("disconnect", false);
    try {
      body.send({ type: "stop", reason: "browser_disconnect" });
    } catch (_error) {
      // The GATT link may already be gone.
    }
    await body.disconnect();
    return;
  }

  try {
    await body.connect();
  } catch (error) {
    body.emit("state", "disconnected");
    const message = describeConnectionError(error);
    if (!/cancel/i.test(error.message || "")) {
      setConnectionFailure(message);
      showToast(message);
      appendLog(message, "error");
    }
  }
});

ui.stopButton.addEventListener("click", () => stopDrive("emergency_stop"));
ui.speedSlider.addEventListener("input", () => {
  ui.speedValue.textContent = `${ui.speedSlider.value}%`;
});
ui.refreshButton.addEventListener("click", () => {
  if (!body.isConnected()) {
    showToast("Connect the ESP32 first.");
    return;
  }
  body.send({ type: "config_get" });
  body.send({ type: "ping" });
});

document.querySelectorAll("[data-drive]").forEach((button) => {
  const direction = button.dataset.drive;
  if (direction === "stop") {
    button.addEventListener("click", () => stopDrive("pad_stop"));
    return;
  }

  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    button.setPointerCapture?.(event.pointerId);
    button.classList.add("is-active");
    startDrive(direction);
  });
  ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"].forEach((eventName) => {
    button.addEventListener(eventName, () => {
      button.classList.remove("is-active");
      stopDrive("drive_release");
    });
  });
});

window.addEventListener("keydown", (event) => {
  if (event.repeat) {
    return;
  }
  const direction = { ArrowUp: "forward", ArrowDown: "reverse", ArrowLeft: "left", ArrowRight: "right" }[event.key];
  if (direction) {
    event.preventDefault();
    startDrive(direction);
  }
});

window.addEventListener("keyup", (event) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
    stopDrive("key_release");
  }
});

[ui.yawSlider, ui.pitchSlider].forEach((slider) => {
  slider.addEventListener("input", () => {
    updateGimbalReadout();
    scheduleGimbalSend(slider === ui.yawSlider ? "yaw" : "pitch");
  });
});

ui.centerGimbalButton.addEventListener("click", () => {
  sendGimbalMove("center");
});

document.querySelectorAll("[data-gimbal]").forEach((button) => {
  button.addEventListener("click", (event) => {
    event.preventDefault();
    sendGimbalMove(button.dataset.gimbal);
  });
});

ui.cameraButton.addEventListener("click", async () => {
  if (cameraStream) {
    stopCamera();
    return;
  }
  await startCamera();
});

ui.cameraSwitchButton.addEventListener("click", async () => {
  if (!cameraStream) {
    await startCamera();
    return;
  }
  stopCamera();
  facingMode = facingMode === "environment" ? "user" : "environment";
  await startCamera();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    stopDrive("page_hidden", false);
  }
});

window.addEventListener("beforeunload", () => {
  stopDrive("page_unload", false);
});

function startDrive(direction) {
  if (!body.isConnected()) {
    showToast("Connect the ESP32 first.");
    return;
  }

  const speed = Number(ui.speedSlider.value) / 100;
  const speeds = {
    forward: [speed, speed],
    reverse: [-speed, -speed],
    left: [speed, -speed],
    right: [-speed, speed]
  }[direction];

  if (!speeds) {
    return;
  }

  activeDrive = { direction, left: speeds[0], right: speeds[1] };
  clearInterval(driveTimer);
  sendDriveFrame();
  driveTimer = window.setInterval(sendDriveFrame, 120);
  ui.motionState.textContent = direction.replace(/^./, (letter) => letter.toUpperCase());
}

function sendDriveFrame() {
  if (!activeDrive || !body.isConnected()) {
    return;
  }
  try {
    body.send({
      type: "motion",
      left_speed: activeDrive.left,
      right_speed: activeDrive.right,
      duration_ms: LIMITS.durationMs,
      ramp_ms: LIMITS.rampMs,
      label: activeDrive.direction
    });
  } catch (error) {
    stopDrive("drive_send_failed", false);
    body.emit("error", error);
  }
}

function stopDrive(reason = "stop", notify = true) {
  clearInterval(driveTimer);
  driveTimer = 0;
  const wasActive = Boolean(activeDrive);
  activeDrive = null;
  document.querySelectorAll(".pad-button.is-active").forEach((button) => button.classList.remove("is-active"));
  ui.motionState.textContent = "Stopped";
  if (notify && wasActive && body.isConnected()) {
    try {
      body.send({ type: "stop", reason });
    } catch (error) {
      body.emit("error", error);
    }
  }
}

function scheduleGimbalSend(axis) {
  clearTimeout(gimbalTimer);
  gimbalTimer = window.setTimeout(() => sendGimbal(axis), 110);
}

function sendGimbal(axis) {
  if (!body.isConnected()) {
    return;
  }
  const slider = axis === "yaw" ? ui.yawSlider : ui.pitchSlider;
  try {
    body.send({
      type: axis === "yaw" ? "head_yaw" : "head_pitch",
      angle: Number(slider.value),
      duration_ms: LIMITS.gimbalDurationMs,
      easing: "ease_out_cubic",
      label: `mobile_${axis}`,
      ...(axis === "pitch" ? { pitch_authority: "user_command" } : {})
    });
  } catch (error) {
    body.emit("error", error);
  }
}

function sendGimbalMove(direction) {
  if (!body.isConnected()) {
    showToast("Connect the ESP32 first.");
    return;
  }

  const normalizedDirection = String(direction ?? "").trim().toLowerCase();
  if (!["left", "right", "up", "down", "center"].includes(normalizedDirection)) {
    return;
  }

  const physicalDirection = normalizedDirection;

  try {
    body.send({
      type: "gimbal_move",
      direction: physicalDirection,
      degrees: normalizedDirection === "center" ? 0 : LIMITS.gimbalNudgeDegrees,
      duration_ms: LIMITS.gimbalDurationMs,
      easing: "ease_out_cubic",
      label: `mobile_gimbal_${normalizedDirection}`,
      ...(["up", "down", "center"].includes(normalizedDirection)
        ? { pitch_authority: "user_command" }
        : {})
    });
    if (normalizedDirection === "center") {
      ui.yawSlider.value = "0";
      ui.pitchSlider.value = "0";
      updateGimbalReadout();
    }
  } catch (error) {
    body.emit("error", error);
  }
}

function updateGimbalReadout() {
  ui.yawValue.textContent = `${ui.yawSlider.value} degrees`;
  ui.pitchValue.textContent = `${ui.pitchSlider.value} degrees`;
}

function handleBodyMessage(message) {
  if (message.type === "telemetry") {
    const left = Number(message.left_speed);
    const right = Number(message.right_speed);
    ui.leftSpeedValue.textContent = formatSpeed(left);
    ui.rightSpeedValue.textContent = formatSpeed(right);
    ui.telemetryMotor.textContent = formatLabel(message.motor_state);
    ui.telemetryRemaining.textContent = `${Number(message.motion_remaining_ms || 0)} ms`;
    ui.telemetryMaxSpeed.textContent = formatSpeed(message.limits?.max_speed ?? LIMITS.maxSpeed);
    ui.telemetryUptime.textContent = formatDuration(message.uptime_ms);
    return;
  }

  if (message.type === "config") {
    const config = message.config || message;
    ui.telemetryMaxSpeed.textContent = formatSpeed(config.max_speed ?? LIMITS.maxSpeed);
    syncGimbalAngles(config);
    return;
  }

  if (message.type === "pong") {
    ui.latencyValue.textContent = body.lastPingAt
      ? `${Math.round(performance.now() - body.lastPingAt)} ms`
      : "--";
    return;
  }

  if (message.type === "ack" && message.cmd === "motion") {
    ui.leftSpeedValue.textContent = formatSpeed(message.left_speed);
    ui.rightSpeedValue.textContent = formatSpeed(message.right_speed);
    return;
  }

  if (message.type === "ack" && (message.cmd === "head_yaw" || message.cmd === "head_pitch")) {
    const slider = message.cmd === "head_yaw" ? ui.yawSlider : ui.pitchSlider;
    const [min, max] = message.cmd === "head_yaw" ? LIMITS.yaw : LIMITS.pitch;
    if (Number.isFinite(Number(message.angle))) {
      slider.value = String(clamp(Number(message.angle), min, max));
      updateGimbalReadout();
    }
  }

  if (message.type === "error") {
    appendLog(`${message.cmd || "device"}: ${message.message || "error"}`, "error");
  }
}

function syncGimbalAngles(config = {}) {
  const yaw = Number(config.head_yaw?.angle);
  const pitch = Number(config.head_pitch?.angle);
  let changed = false;

  if (Number.isFinite(yaw)) {
    ui.yawSlider.value = String(clamp(yaw, ...LIMITS.yaw));
    changed = true;
  }
  if (Number.isFinite(pitch)) {
    ui.pitchSlider.value = String(clamp(pitch, ...LIMITS.pitch));
    changed = true;
  }
  if (changed) {
    updateGimbalReadout();
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    showToast("Camera is unavailable in this browser.");
    return;
  }
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode } },
      audio: false
    });
    ui.cameraPreview.srcObject = cameraStream;
    ui.liveFrame.dataset.camera = "on";
    ui.cameraButton.setAttribute("aria-label", "Stop camera");
    ui.cameraButton.setAttribute("title", "Stop camera");
  } catch (error) {
    showToast(error.message || "Camera permission was denied.");
    appendLog(error.message || "Camera permission was denied.", "error");
  }
}

function stopCamera() {
  cameraStream?.getTracks().forEach((track) => track.stop());
  cameraStream = null;
  ui.cameraPreview.srcObject = null;
  delete ui.liveFrame.dataset.camera;
  ui.cameraButton.setAttribute("aria-label", "Start camera");
  ui.cameraButton.setAttribute("title", "Start camera");
}

function appendLog(message, level = "info") {
  if (!ui.eventLog) {
    return;
  }
  const line = document.createElement("div");
  line.className = level === "error" ? "log-error" : "";
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  ui.eventLog.append(line);
  logCount += 1;
  while (logCount > 40 && ui.eventLog.firstElementChild) {
    ui.eventLog.firstElementChild.remove();
    logCount -= 1;
  }
  ui.eventLog.scrollTop = ui.eventLog.scrollHeight;
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => ui.toast.classList.remove("is-visible"), 2800);
}

function setConnectionFailure(message) {
  ui.connectionState.dataset.state = "error";
  ui.connectionLabel.textContent = "Connection failed";
  ui.connectionDetail.textContent = message;
}

function describeConnectionError(error) {
  const message = error?.message || String(error);
  const availability = getBluetoothAvailability();
  if (!availability.supported) {
    return availability.message;
  }
  if (/cancelled|canceled|abort/i.test(message)) {
    return "Bluetooth device selection was cancelled.";
  }
  if (/notfound|no device|not found/i.test(message)) {
    return "LOOI-S3 was not selected. Check power and firmware, then try again.";
  }
  if (/security|permission|not allowed/i.test(message)) {
    return "Bluetooth permission was blocked. Allow Nearby devices permission, then try again.";
  }
  return `Bluetooth connection failed: ${message}`;
}

function getBluetoothAvailability() {
  const navigatorInfo = globalThis.navigator;
  const userAgent = navigatorInfo?.userAgent ?? "";
  const isAppleMobile = /iPad|iPhone|iPod/i.test(userAgent) ||
    (navigatorInfo?.platform === "MacIntel" && navigatorInfo.maxTouchPoints > 1);

  if (isAppleMobile) {
    return {
      supported: false,
      message: "iPhone and iPad browsers do not support direct website Bluetooth. Use an Android phone with Chrome or Edge."
    };
  }

  if (!globalThis.isSecureContext) {
    return {
      supported: false,
      message: "Bluetooth requires HTTPS. Open the deployed https:// site in Chrome or Edge, not a local network HTTP address."
    };
  }

  if (!navigatorInfo?.bluetooth?.requestDevice) {
    return {
      supported: false,
      message: "This browser does not support Web Bluetooth. Use current Chrome or Edge on Android, opened directly rather than inside another app."
    };
  }

  return { supported: true, message: "" };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatSpeed(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(2) : "--";
}

function formatLabel(value) {
  return String(value || "stopped").replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function formatDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value || 0) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

updateGimbalReadout();
ui.speedValue.textContent = `${ui.speedSlider.value}%`;
window.lucide?.createIcons();
globalThis.navigator?.serviceWorker?.register("../sw.js").catch(() => {});
const bluetoothAvailability = getBluetoothAvailability();
if (bluetoothAvailability.supported) {
  appendLog("Bluetooth controller ready.");
} else {
  ui.connectionState.dataset.state = "unsupported";
  ui.connectionLabel.textContent = "Unavailable";
  ui.connectionDetail.textContent = bluetoothAvailability.message;
  ui.connectButton.disabled = true;
  appendLog(bluetoothAvailability.message, "error");
}
