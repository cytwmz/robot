#include <Arduino.h>
#include <ArduinoJson.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <esp_arduino_version.h>

#include <math.h>

// This firmware intentionally contains no AI, personality, or Life
// Engine logic. The phone/server side will decide high-level intent later.
// The ESP32 is only the final motor safety layer that executes short, clamped
// motion commands and automatically stops.

// TB6612FNG two-channel differential drive: one motor per side.
// ESP32-S3-WROOM-1-N16R8 mapping. These pins avoid strapping pins, USB,
// UART0, and the module's Octal PSRAM pins.
constexpr uint8_t TB6612_AIN1 = 4;
constexpr uint8_t TB6612_AIN2 = 5;
// Physical wheel mapping verified on the current car. Never swap these based
// on the TB6612 A/B labels: GPIO6 is the left wheel and GPIO9 is the right.
constexpr uint8_t LEFT_WHEEL_PWM_PIN = 6;
constexpr uint8_t TB6612_BIN1 = 7;
constexpr uint8_t TB6612_BIN2 = 8;
constexpr uint8_t RIGHT_WHEEL_PWM_PIN = 9;
constexpr uint8_t TB6612_STBY = 10;
constexpr uint8_t LEFT_PWM_CHANNEL = 0;
constexpr uint8_t RIGHT_PWM_CHANNEL = 1;

// Motion commands contain direct left/right wheel speeds in LOOI's face frame.
// These signs map that frame to the physical chassis. Keep both signs the same
// when a positive command should drive both sides forward.
constexpr int8_t LEFT_DRIVE_SIGN = -1;
constexpr int8_t RIGHT_DRIVE_SIGN = -1;

// Direct ESP32 PWM outputs for the two-axis servo gimbal.
// Physical gimbal wiring: horizontal/yaw servo is GPIO15 and vertical/pitch
// servo is GPIO16. Both axes use positional servos. Keep the outputs low until
// a movement command arrives so boot cannot force either axis into a hard stop.
constexpr uint8_t HEAD_YAW_PWM_PIN = 15;
constexpr uint8_t HEAD_PITCH_PWM_PIN = 16;
constexpr uint8_t HEAD_YAW_PWM_CHANNEL = 2;
constexpr uint8_t HEAD_PITCH_PWM_CHANNEL = 3;
constexpr uint8_t HEAD_SERVO_FREQUENCY_HZ = 50;
// Validated by the hardware self-check on this ESP32-S3 at the 50 Hz servo rate.
constexpr uint8_t HEAD_SERVO_PWM_RESOLUTION_BITS = 14;
constexpr uint32_t HEAD_SERVO_PERIOD_US =
    1000000UL / HEAD_SERVO_FREQUENCY_HZ;
constexpr uint32_t HEAD_SERVO_PWM_MAX_DUTY =
    (1UL << HEAD_SERVO_PWM_RESOLUTION_BITS) - 1UL;
// External gimbal commands use degrees from the zero captured at BLE
// connection time. Do not command the electrical end-points of a hobby servo:
// those values can make either positional servo stall against its bracket.
constexpr uint16_t HEAD_SERVO_START_PULSE = 1500;
constexpr uint16_t HEAD_YAW_SAFE_MIN_PULSE = 1100;
constexpr uint16_t HEAD_YAW_SAFE_MAX_PULSE = 1900;
constexpr uint16_t HEAD_PITCH_SAFE_MIN_PULSE = 1250;
constexpr uint16_t HEAD_PITCH_SAFE_MAX_PULSE = 1750;
// Release each positional servo after a move. This avoids holding torque when
// the mechanism reaches a mechanical stop while preserving the last angle for
// subsequent relative commands.
constexpr bool HEAD_YAW_RELEASE_AFTER_MOVE = true;
constexpr bool HEAD_PITCH_RELEASE_AFTER_MOVE = true;
constexpr float HEAD_YAW_MAX_ANGLE = 180.0f;
constexpr float HEAD_PITCH_MAX_ANGLE = 90.0f;
constexpr float GIMBAL_NUDGE_DEFAULT_DEGREES = 15.0f;
constexpr float GIMBAL_NUDGE_MAX_DEGREES = 45.0f;
// Protocol directions are converted to pulse direction here. Browser clients
// send these canonical directions directly without applying another inversion.
constexpr int8_t HEAD_YAW_LEFT_PULSE_SIGN = -1;
constexpr int8_t HEAD_PITCH_UP_PULSE_SIGN = 1;
constexpr uint32_t HEAD_PITCH_DEFAULT_DURATION_MS = 350;
constexpr uint32_t HEAD_PITCH_MAX_DURATION_MS = 2000;
constexpr uint32_t HEAD_PITCH_UPDATE_INTERVAL_MS = 20;
constexpr char HEAD_PITCH_DEFAULT_EASING[] = "ease_in_out_cubic";
constexpr char HEAD_PITCH_EASE_OUT_CUBIC[] = "ease_out_cubic";
constexpr char HEAD_PITCH_EASE_OUT_QUART[] = "ease_out_quart";
constexpr char HEAD_PITCH_EXPONENTIAL_SMOOTHING[] = "exponential_smoothing";
constexpr char HEAD_PITCH_CRITICALLY_DAMPED_SPRING[] =
    "critically_damped_spring";
constexpr char HEAD_PITCH_MINIMUM_JERK[] = "minimum_jerk";
// Pitch can hit the gimbal bracket if an autonomous client sends a stale
// absolute target. Only an explicit local user command may
// energize the pitch axis. The browser adds this authority to those commands.
constexpr char PITCH_AUTHORITY_USER_COMMAND[] = "user_command";

// The TB6612 B channel is wired opposite to the A channel on this chassis.
// Keep the sides matched so a positive command drives both wheels forward.
constexpr bool LEFT_INVERT = false;
constexpr bool RIGHT_INVERT = true;

// TB6612 wiring notes:
// - Connect AIN1/AIN2/PWMA to the left motor channel and BIN1/BIN2/PWMB to
//   the right motor channel.
// - STBY must be driven by the ESP32 pin above; it is held low while stopped.
// - Tie ESP32 GND, TB6612 GND, and both servo grounds together.
// - Power TB6612 VM and the servos from suitable external supplies, not the
//   ESP32 3.3V rail.

constexpr uint32_t PWM_FREQUENCY_HZ = 1000;
constexpr uint8_t PWM_RESOLUTION_BITS = 8;
constexpr uint16_t PWM_MAX_DUTY = (1u << PWM_RESOLUTION_BITS) - 1u;

constexpr uint32_t SERIAL_BAUD = 115200;

// Keep the name and 128-bit service UUID in the 31-byte primary advertising
// packet so phones can discover the body without relying on a scan response.
constexpr char BLE_DEVICE_NAME[] = "LOOI-S3";
constexpr char BLE_SERVICE_UUID[] = "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0001";
constexpr char BLE_COMMAND_CHARACTERISTIC_UUID[] =
    "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0002";
constexpr char BLE_EVENTS_CHARACTERISTIC_UUID[] =
    "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0003";
constexpr size_t BLE_NOTIFY_CHUNK_SIZE = 180;
constexpr size_t BLE_COMMAND_BUFFER_MAX = 4096;

constexpr float FIRMWARE_HARD_MAX_SPEED = 0.15f;
constexpr float DEFAULT_RUNTIME_MAX_SPEED = 0.12f;
constexpr uint32_t MAX_DURATION_MS = 1000;
constexpr uint32_t MIN_DURATION_MS = 50;
constexpr uint32_t DEFAULT_DURATION_MS = 300;
constexpr float DEFAULT_DEADBAND = 0.03f;
constexpr uint32_t DEFAULT_RAMP_MS = 120;
constexpr uint8_t DEFAULT_MIN_PWM = 70;
// Do not allow an old browser calibration to restore a higher minimum duty
// cycle and undo the reduced-speed safety limit.
constexpr uint8_t MAX_SAFE_MIN_PWM = 70;
constexpr uint32_t MAX_RAMP_MS = 500;
constexpr uint32_t MOTOR_UPDATE_INTERVAL_MS = 20;

constexpr uint32_t TELEMETRY_INTERVAL_MS = 1000;
constexpr uint32_t BLE_ADVERTISING_RECOVERY_INTERVAL_MS = 3000;
constexpr size_t JSON_DOC_SIZE = 2048;

BLEServer *bleServer = nullptr;
BLECharacteristic *bleEventsCharacteristic = nullptr;
BLEAdvertising *bleAdvertising = nullptr;
String bleCommandBuffer;
uint8_t blePendingData[BLE_COMMAND_BUFFER_MAX];
size_t blePendingDataLength = 0;
portMUX_TYPE blePendingDataMux = portMUX_INITIALIZER_UNLOCKED;
volatile bool bleRxBufferOverflow = false;
bool bleClientConnected = false;
bool bleReady = false;
bool bleAdvertisingActive = false;
uint8_t connectedClientCount = 0;
uint32_t lastBleAdvertisingAttemptAt = 0;

bool motionActive = false;
bool rampingDown = false;
float currentLeftSpeed = 0.0f;
float currentRightSpeed = 0.0f;
float startLeftSpeed = 0.0f;
float startRightSpeed = 0.0f;
float targetLeftSpeed = 0.0f;
float targetRightSpeed = 0.0f;

uint32_t motionStartAt = 0;
uint32_t motionEndAt = 0;
uint32_t rampDownStartAt = 0;
uint32_t motionRampMs = DEFAULT_RAMP_MS;
uint32_t lastCommandAt = 0;
uint32_t lastTelemetryAt = 0;
uint32_t lastMotorUpdateAt = 0;

float runtimeMaxSpeed = DEFAULT_RUNTIME_MAX_SPEED;
float leftTrim = 1.0f;
float rightTrim = 1.0f;
float runtimeDeadband = DEFAULT_DEADBAND;
uint32_t defaultRampMs = DEFAULT_RAMP_MS;
uint8_t minPwm = DEFAULT_MIN_PWM;
char motionLabel[48] = "";
uint16_t currentHeadYawPulse = HEAD_SERVO_START_PULSE;
uint16_t headYawStartPulse = HEAD_SERVO_START_PULSE;
uint16_t headYawTargetPulse = HEAD_SERVO_START_PULSE;
uint16_t headYawZeroPulse = HEAD_SERVO_START_PULSE;
int8_t headYawDirection = 1;
bool headYawPwmAttached = false;
uint32_t headYawStartAt = 0;
uint32_t headYawDurationMs = 0;
uint32_t headYawLastUpdateAt = 0;
bool headYawMoving = false;
char headYawEasing[32] = "ease_in_out_cubic";
uint16_t currentHeadPitchPulse = HEAD_SERVO_START_PULSE;
uint16_t headPitchStartPulse = HEAD_SERVO_START_PULSE;
uint16_t headPitchTargetPulse = HEAD_SERVO_START_PULSE;
uint16_t headPitchZeroPulse = HEAD_SERVO_START_PULSE;
int8_t headPitchDirection = 1;
bool headPitchPwmAttached = false;
uint32_t headPitchStartAt = 0;
uint32_t headPitchDurationMs = 0;
uint32_t headPitchLastUpdateAt = 0;
bool headPitchMoving = false;
char headPitchEasing[32] = "ease_in_out_cubic";

void setupPins();
void prepareServoPinsForBoot();
void setupHeadServo();
void setupBle();
bool startBleAdvertising(const char *reason);
void updateBleAdvertising();
void appendPendingBleData(const uint8_t *payload, size_t length);
void processPendingBleData();
void handleBleCommandData(const uint8_t *payload, size_t length);
void handleJsonMessage(const uint8_t *payload, size_t length);
void handleMotionCommand(JsonObjectConst root);
void handleHeadYawCommand(JsonObjectConst root);
void handleHeadPitchCommand(JsonObjectConst root);
void handleGimbalMoveCommand(JsonObjectConst root);
void handleGimbalZeroCommand(JsonObjectConst root);
void handleStopCommand(JsonObjectConst root);
void handleConfigUpdateCommand(JsonObjectConst root);
void handleConfigGetCommand(JsonObjectConst root);
void sendTelemetry();
void sendConfig(JsonVariantConst requestId);
void sendAck(const char *cmd, JsonVariantConst requestId);
void sendAck(const char *cmd, JsonVariantConst requestId, const char *reason);
void sendAck(const char *cmd, JsonVariantConst requestId, uint32_t durationMs,
             float leftSpeed, float rightSpeed, uint32_t rampMs,
             const char *label);
void sendError(const char *cmd, const char *message, JsonVariantConst requestId);
void sendBleText(const String &message);
void setDifferentialDrive(float leftSpeed, float rightSpeed, uint32_t durationMs,
                          uint32_t rampMs, const char *label);
void updateRampedMotion(bool force = false);
void updateHeadYawMotion(bool force = false);
void updateHeadPitchMotion(bool force = false);
void applyMotorSpeeds(float leftSpeed, float rightSpeed);
void setMotorSide(uint8_t in1Pin, uint8_t in2Pin, uint8_t enablePin, float speed,
                  bool invert, uint8_t pwmChannel);
bool attachMotorPwm(uint8_t pin, uint8_t channel);
void writeMotorPwm(uint8_t pin, uint8_t channel, uint32_t duty);
bool attachServoPwm(uint8_t pin, uint8_t channel);
bool ensureHeadServoPwmAttached(bool yawAxis);
void idleServoPwm(uint8_t pin, uint8_t channel);
void writeServoPwm(uint8_t pin, uint8_t channel, uint16_t pulseWidthUs);
void writeHeadYawPulse(uint16_t pulse);
void writeHeadPitchPulse(uint16_t pulse);
void setHeadYawImmediate(uint16_t pulse, const char *label);
void setHeadPitchImmediate(uint16_t pulse, const char *label);
void startHeadYawTransition(uint16_t targetPulse, uint32_t durationMs,
                            const char *easing, const char *label);
void startHeadPitchTransition(uint16_t targetPulse, uint32_t durationMs,
                              const char *easing, const char *label);
void stopHeadMotion(const char *reason);
void stopMotors(const char *reason);
void addConfig(JsonObject target);
void addConfigWarnings(JsonArray warnings, const char *field, double requested,
                       double accepted);
void sanitizeLabel(const char *input, char *output, size_t outputSize);

bool isStrictNumber(JsonVariantConst value);
bool isFiniteNumber(double value);
bool hasPitchMovementAuthority(JsonObjectConst root);
float clampSpeed(float value);
float applyDeadband(float value);
float applyTrimAndClamp(float value, float trim);
uint16_t clampHeadYawPulse(double pulse);
uint16_t clampHeadPitchPulse(double pulse);
float clampGimbalAngle(double angle, float maxAngle);
uint16_t gimbalAngleToPulse(float angle, float maxAngle, uint16_t zeroPulse,
                            int8_t direction, bool yawAxis);
float gimbalPulseToAngle(uint16_t pulse, float maxAngle, uint16_t zeroPulse,
                         int8_t direction, bool yawAxis);
uint16_t gimbalNudgePulse(uint16_t currentPulse, float degrees, float maxAngle,
                          int8_t pulseDirection, bool yawAxis);
float clampGimbalNudgeDegrees(double degrees);
void captureGimbalZero(const char *reason);
uint32_t clampHeadPitchDuration(double durationMs);
const char *normalizeHeadPitchEasing(JsonVariantConst value);
float easeHeadPitchProgress(float progress, const char *easing);
uint32_t clampDuration(double durationMs);
uint32_t clampRamp(double rampMs, uint32_t durationMs);
uint8_t clampMinPwm(double value);
bool isStopped();
bool deadlineReached(uint32_t now, uint32_t deadline);
uint32_t motionRemainingMs(uint32_t now);
const char *motorState();
void addRequestId(JsonDocument &doc, JsonVariantConst requestId);

template <typename TDoc>
void sendJsonEvent(const TDoc &doc) {
  String message;
  serializeJson(doc, message);
  message += '\n';
  sendBleText(message);
}

void setup() {
  prepareServoPinsForBoot();
  Serial.begin(SERIAL_BAUD);
  delay(250);

  Serial.println();
  Serial.println("[BOOT] LOOI body firmware starting");
  Serial.println("[BOOT] ESP32 will only execute short, safe motor commands");

  setupBle();
  setupPins();
  setupHeadServo();
  stopMotors("boot");
}

void loop() {
  const uint32_t now = millis();

  processPendingBleData();
  updateRampedMotion();
  updateHeadYawMotion();
  updateHeadPitchMotion();
  updateBleAdvertising();

  if (!motionActive && !isStopped()) {
    Serial.println("[SAFE] No active motion scheduled, forcing stop");
    stopMotors("idle_safety");
  }

  if (now - lastTelemetryAt >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryAt = now;
    sendTelemetry();
  }
}

void setupPins() {
  pinMode(TB6612_AIN1, OUTPUT);
  pinMode(TB6612_AIN2, OUTPUT);
  pinMode(TB6612_BIN1, OUTPUT);
  pinMode(TB6612_BIN2, OUTPUT);
  pinMode(TB6612_STBY, OUTPUT);

  if (!attachMotorPwm(LEFT_WHEEL_PWM_PIN, LEFT_PWM_CHANNEL)) {
    Serial.println("[BOOT] Failed to attach left PWM pin");
  }

  if (!attachMotorPwm(RIGHT_WHEEL_PWM_PIN, RIGHT_PWM_CHANNEL)) {
    Serial.println("[BOOT] Failed to attach right PWM pin");
  }

  digitalWrite(TB6612_AIN1, LOW);
  digitalWrite(TB6612_AIN2, LOW);
  digitalWrite(TB6612_BIN1, LOW);
  digitalWrite(TB6612_BIN2, LOW);
  digitalWrite(TB6612_STBY, LOW);
  writeMotorPwm(LEFT_WHEEL_PWM_PIN, LEFT_PWM_CHANNEL, 0);
  writeMotorPwm(RIGHT_WHEEL_PWM_PIN, RIGHT_PWM_CHANNEL, 0);

  Serial.printf("[BOOT] TB6612 left=A(%u/%u,pwm=%u) right=B(%u/%u,pwm=%u) STBY=%u\n",
                TB6612_AIN1, TB6612_AIN2, LEFT_WHEEL_PWM_PIN, TB6612_BIN1,
                TB6612_BIN2, RIGHT_WHEEL_PWM_PIN, TB6612_STBY);
}

void prepareServoPinsForBoot() {
  // Do not emit a servo pulse during boot. A fixed 1500 us pulse can force a
  // positional servo to move before the driver knows its safe zero position.
  pinMode(HEAD_YAW_PWM_PIN, OUTPUT);
  pinMode(HEAD_PITCH_PWM_PIN, OUTPUT);
  digitalWrite(HEAD_YAW_PWM_PIN, LOW);
  digitalWrite(HEAD_PITCH_PWM_PIN, LOW);
}

void setupHeadServo() {
  captureGimbalZero("boot");

  Serial.printf(
      "[BOOT] Direct-PWM 2D gimbal armed yaw_pin=%u channel=%u "
      "pitch_pin=%u channel=%u yaw_safe=%u..%u pitch_safe=%u..%u\n",
      HEAD_YAW_PWM_PIN, HEAD_YAW_PWM_CHANNEL, HEAD_PITCH_PWM_PIN,
      HEAD_PITCH_PWM_CHANNEL, HEAD_YAW_SAFE_MIN_PULSE,
      HEAD_YAW_SAFE_MAX_PULSE, HEAD_PITCH_SAFE_MIN_PULSE,
      HEAD_PITCH_SAFE_MAX_PULSE);
}

class LooiBleServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *server) override {
    (void)server;
    bleClientConnected = true;
    bleAdvertisingActive = false;
    connectedClientCount = 1;
    bleCommandBuffer = "";
    // Connecting must never alter either servo reference or emit a pulse.
    // The last known position remains the only reference until a user command.
    Serial.println("[BLE] Client connected; gimbal left untouched");
  }

  void onDisconnect(BLEServer *server) override {
    (void)server;
    bleClientConnected = false;
    connectedClientCount = 0;
    bleCommandBuffer = "";
    portENTER_CRITICAL(&blePendingDataMux);
    blePendingDataLength = 0;
    portEXIT_CRITICAL(&blePendingDataMux);
    Serial.println("[BLE] Client disconnected");
    stopMotors("ble_disconnect");
    stopHeadMotion("ble_disconnect");
    startBleAdvertising("disconnect");
  }
};

class LooiBleCommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic *characteristic) override {
    const String value = characteristic->getValue();
    if (value.length() == 0) {
      return;
    }

    appendPendingBleData(reinterpret_cast<const uint8_t *>(value.c_str()),
                         value.length());
  }
};

void setupBle() {
  // The standard ESP32 BLE stack is used here. It is verified on this S3
  // board and avoids the NimBLE controller initialization crash.
  BLEDevice::init(BLE_DEVICE_NAME);
  BLEDevice::setPower(ESP_PWR_LVL_P9);

  bleServer = BLEDevice::createServer();
  if (!bleServer) {
    Serial.println("[BLE] Failed to create BLE server");
    bleReady = false;
    return;
  }
  bleServer->setCallbacks(new LooiBleServerCallbacks());

  BLEService *service = bleServer->createService(BLE_SERVICE_UUID);
  if (!service) {
    Serial.println("[BLE] Failed to create BLE service");
    bleReady = false;
    return;
  }
  BLECharacteristic *commandCharacteristic = service->createCharacteristic(
      BLE_COMMAND_CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_WRITE |
                                           BLECharacteristic::PROPERTY_WRITE_NR);
  if (!commandCharacteristic) {
    Serial.println("[BLE] Failed to create command characteristic");
    bleReady = false;
    return;
  }
  commandCharacteristic->setCallbacks(new LooiBleCommandCallbacks());

  bleEventsCharacteristic = service->createCharacteristic(
      BLE_EVENTS_CHARACTERISTIC_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  if (!bleEventsCharacteristic) {
    Serial.println("[BLE] Failed to create events characteristic");
    bleReady = false;
    return;
  }

  bleEventsCharacteristic->addDescriptor(new BLE2902());
  service->start();

  bleAdvertising = BLEDevice::getAdvertising();
  if (!bleAdvertising) {
    Serial.println("[BLE] Failed to create advertising controller");
    bleReady = false;
    return;
  }

  // Keep the service UUID in the primary packet for browser filtering and put
  // the complete name in the scan response for phone Bluetooth scanners.
  bleAdvertising->setScanResponse(true);
  bleAdvertising->addServiceUUID(BLE_SERVICE_UUID);
  bleAdvertising->setMinInterval(0xA0);  // 100 ms
  bleAdvertising->setMaxInterval(0xC0);  // 120 ms

  bleReady = true;
  startBleAdvertising("boot");
}

void appendPendingBleData(const uint8_t *payload, size_t length) {
  if (!payload || length == 0) {
    return;
  }

  portENTER_CRITICAL(&blePendingDataMux);
  if (blePendingDataLength + length > BLE_COMMAND_BUFFER_MAX) {
    blePendingDataLength = 0;
    bleRxBufferOverflow = true;
  } else {
    memcpy(blePendingData + blePendingDataLength, payload, length);
    blePendingDataLength += length;
  }
  portEXIT_CRITICAL(&blePendingDataMux);
}

void processPendingBleData() {
  if (bleRxBufferOverflow) {
    bleRxBufferOverflow = false;
    bleCommandBuffer = "";
    Serial.println("[SAFE] BLE RX buffer overflow");
    stopMotors("ble_rx_buffer_overflow");
    sendError("unknown", "BLE RX buffer overflow", JsonVariantConst());
    return;
  }

  static uint8_t data[BLE_COMMAND_BUFFER_MAX];
  size_t length = 0;
  portENTER_CRITICAL(&blePendingDataMux);
  if (blePendingDataLength > 0) {
    length = blePendingDataLength;
    memcpy(data, blePendingData, length);
    blePendingDataLength = 0;
  }
  portEXIT_CRITICAL(&blePendingDataMux);

  if (length == 0) {
    return;
  }

  handleBleCommandData(data, length);
}

bool startBleAdvertising(const char *reason) {
  lastBleAdvertisingAttemptAt = millis();

  if (!bleReady || !bleAdvertising) {
    Serial.printf("[BLE] Advertising skipped: stack unavailable reason=%s\n",
                  reason ? reason : "unknown");
    return false;
  }

  const bool started = bleAdvertising->start();
  bleAdvertisingActive = started;
  if (started) {
    Serial.printf("[BLE] Advertising as %s service=%s reason=%s\n",
                  BLE_DEVICE_NAME, BLE_SERVICE_UUID,
                  reason ? reason : "unknown");
  } else {
    Serial.printf("[BLE] Advertising start failed reason=%s; will retry\n",
                  reason ? reason : "unknown");
  }

  return started;
}

void updateBleAdvertising() {
  if (!bleReady || bleClientConnected || !bleAdvertising ||
      bleAdvertisingActive) {
    return;
  }

  const uint32_t now = millis();
  if (now - lastBleAdvertisingAttemptAt >= BLE_ADVERTISING_RECOVERY_INTERVAL_MS) {
    startBleAdvertising("recovery");
  }
}

void handleBleCommandData(const uint8_t *payload, size_t length) {
  for (size_t index = 0; index < length; index++) {
    const char value = static_cast<char>(payload[index]);

    if (value == '\r') {
      continue;
    }

    if (value == '\n') {
      if (bleCommandBuffer.length() > 0) {
        handleJsonMessage(
            reinterpret_cast<const uint8_t *>(bleCommandBuffer.c_str()),
            bleCommandBuffer.length());
        bleCommandBuffer = "";
      }
      continue;
    }

    bleCommandBuffer += value;

    if (bleCommandBuffer.length() > BLE_COMMAND_BUFFER_MAX) {
      Serial.println("[SAFE] BLE command buffer overflow");
      bleCommandBuffer = "";
      stopMotors("ble_command_overflow");
      sendError("unknown", "BLE command too large", JsonVariantConst());
      return;
    }
  }
}

void handleJsonMessage(const uint8_t *payload, size_t length) {
  StaticJsonDocument<JSON_DOC_SIZE> doc;
  const DeserializationError error = deserializeJson(doc, payload, length);

  if (error) {
    Serial.printf("[SAFE] Invalid JSON received: %s\n", error.c_str());
    stopMotors("invalid_json");
    sendError("unknown", "Invalid JSON", JsonVariantConst());
    return;
  }

  if (!doc.is<JsonObjectConst>()) {
    Serial.println("[SAFE] Invalid JSON root, expected object");
    stopMotors("invalid_json_root");
    sendError("unknown", "JSON root must be an object", JsonVariantConst());
    return;
  }

  const JsonObjectConst root = doc.as<JsonObjectConst>();
  const JsonVariantConst requestId = root["id"];
  const JsonVariantConst typeValue = root["type"];

  if (!typeValue.is<const char *>()) {
    Serial.println("[SAFE] Unknown command: missing or invalid type");
    stopMotors("unknown_command");
    sendError("unknown", "Missing or invalid command type", requestId);
    return;
  }

  const char *type = typeValue.as<const char *>();

  if (strcmp(type, "motion") == 0) {
    handleMotionCommand(root);
    return;
  }

  if (strcmp(type, "head_yaw") == 0) {
    handleHeadYawCommand(root);
    return;
  }

  if (strcmp(type, "head_pitch") == 0) {
    handleHeadPitchCommand(root);
    return;
  }

  if (strcmp(type, "gimbal_move") == 0) {
    handleGimbalMoveCommand(root);
    return;
  }

  if (strcmp(type, "gimbal_zero") == 0) {
    handleGimbalZeroCommand(root);
    return;
  }

  if (strcmp(type, "stop") == 0) {
    handleStopCommand(root);
    return;
  }

  if (strcmp(type, "config_update") == 0) {
    handleConfigUpdateCommand(root);
    return;
  }

  if (strcmp(type, "config_get") == 0) {
    handleConfigGetCommand(root);
    return;
  }

  if (strcmp(type, "ping") == 0) {
    lastCommandAt = millis();

    StaticJsonDocument<128> response;
    addRequestId(response, requestId);
    response["type"] = "pong";
    response["uptime_ms"] = millis();

    sendJsonEvent(response);
    return;
  }

  Serial.printf("[SAFE] Unknown command received: %s\n", type);
  stopMotors("unknown_command");
  sendError(type, "Unknown command", requestId);
}

void handleMotionCommand(JsonObjectConst root) {
  const JsonVariantConst requestId = root["id"];
  const JsonVariantConst leftSpeedValue = root["left_speed"];
  const JsonVariantConst rightSpeedValue = root["right_speed"];
  const JsonVariantConst durationValue = root["duration_ms"];
  const JsonVariantConst rampValue = root["ramp_ms"];

  if (!isStrictNumber(leftSpeedValue) || !isStrictNumber(rightSpeedValue)) {
    Serial.println("[SAFE] Motion rejected: left/right speed missing or invalid");
    stopMotors("invalid_motion");
    sendError("motion", "left_speed and right_speed must be numeric", requestId);
    return;
  }

  const double rawLeftSpeed = leftSpeedValue.as<double>();
  const double rawRightSpeed = rightSpeedValue.as<double>();

  if (!isFiniteNumber(rawLeftSpeed) || !isFiniteNumber(rawRightSpeed)) {
    Serial.println("[SAFE] Motion rejected: left/right speed not finite");
    stopMotors("invalid_motion");
    sendError("motion", "Motion values must be finite", requestId);
    return;
  }

  double rawDuration = DEFAULT_DURATION_MS;
  bool durationDefaulted = false;

  if (durationValue.isNull()) {
    durationDefaulted = true;
  } else if (!isStrictNumber(durationValue)) {
    durationDefaulted = true;
  } else {
    rawDuration = durationValue.as<double>();

    if (!isFiniteNumber(rawDuration)) {
      durationDefaulted = true;
    }
  }

  if (durationDefaulted) {
    rawDuration = DEFAULT_DURATION_MS;
    Serial.printf("[SAFE] Motion duration missing/invalid, using default %lu ms\n",
                  static_cast<unsigned long>(DEFAULT_DURATION_MS));
  }

  const float acceptedLeftSpeed =
      applyDeadband(clampSpeed(static_cast<float>(rawLeftSpeed)));
  const float acceptedRightSpeed =
      applyDeadband(clampSpeed(static_cast<float>(rawRightSpeed)));
  const uint32_t acceptedDuration = clampDuration(rawDuration);
  double rawRamp = defaultRampMs;

  if (!rampValue.isNull() && isStrictNumber(rampValue) &&
      isFiniteNumber(rampValue.as<double>())) {
    rawRamp = rampValue.as<double>();
  }

  const uint32_t acceptedRamp = clampRamp(rawRamp, acceptedDuration);
  char acceptedLabel[48] = "";
  sanitizeLabel(root["label"].is<const char *>() ? root["label"].as<const char *>()
                                                 : "motion",
                acceptedLabel, sizeof(acceptedLabel));

  Serial.printf(
      "[CMD] Differential motion received left=%.3f right=%.3f duration=%lu ramp=%lu "
      "label=%s\n",
      static_cast<float>(rawLeftSpeed), static_cast<float>(rawRightSpeed),
      static_cast<unsigned long>(acceptedDuration),
      static_cast<unsigned long>(acceptedRamp), acceptedLabel);

  setDifferentialDrive(acceptedLeftSpeed, acceptedRightSpeed, acceptedDuration,
                       acceptedRamp, acceptedLabel);

  const bool commandAdjusted =
      fabsf(static_cast<float>(rawLeftSpeed) - acceptedLeftSpeed) > 0.0001f ||
      fabsf(static_cast<float>(rawRightSpeed) - acceptedRightSpeed) > 0.0001f ||
      fabsf(static_cast<float>(rawDuration) - acceptedDuration) > 0.5f ||
      fabsf(static_cast<float>(rawRamp) - acceptedRamp) > 0.5f ||
      fabsf(acceptedLeftSpeed - targetLeftSpeed) > 0.0001f ||
      fabsf(acceptedRightSpeed - targetRightSpeed) > 0.0001f;

  if (commandAdjusted) {
    Serial.printf(
        "[SAFE] Differential motion clamped -> left=%.3f right=%.3f duration=%lu "
        "ramp=%lu\n",
        targetLeftSpeed, targetRightSpeed,
        static_cast<unsigned long>(acceptedDuration),
        static_cast<unsigned long>(acceptedRamp));
  }

  sendAck("motion", requestId, acceptedDuration, targetLeftSpeed,
          targetRightSpeed, acceptedRamp, motionLabel);
}

void handleHeadYawCommand(JsonObjectConst root) {
  const JsonVariantConst requestId = root["id"];
  const JsonVariantConst angleValue = root["angle"];

  if (!isStrictNumber(angleValue) || !isFiniteNumber(angleValue.as<double>())) {
    sendError("head_yaw", "angle must be numeric", requestId);
    return;
  }

  const double requestedAngle = angleValue.as<double>();
  const float acceptedAngle = clampGimbalAngle(requestedAngle, HEAD_YAW_MAX_ANGLE);
  const uint16_t targetPulse = gimbalAngleToPulse(
      acceptedAngle, HEAD_YAW_MAX_ANGLE, headYawZeroPulse, headYawDirection,
      true);
  const JsonVariantConst durationValue = root["duration_ms"];
  double rawDuration = HEAD_PITCH_DEFAULT_DURATION_MS;

  if (!durationValue.isNull() && isStrictNumber(durationValue) &&
      isFiniteNumber(durationValue.as<double>())) {
    rawDuration = durationValue.as<double>();
  }

  const uint32_t acceptedDuration = clampHeadPitchDuration(rawDuration);
  const char *acceptedEasing = normalizeHeadPitchEasing(root["easing"]);
  char acceptedLabel[48] = "";
  sanitizeLabel(root["label"].is<const char *>() ? root["label"].as<const char *>()
                                                 : "head_yaw",
                acceptedLabel, sizeof(acceptedLabel));

  updateHeadYawMotion(true);
  startHeadYawTransition(targetPulse, acceptedDuration, acceptedEasing,
                         acceptedLabel);
  lastCommandAt = millis();

  StaticJsonDocument<512> doc;
  addRequestId(doc, requestId);
  doc["type"] = "ack";
  doc["cmd"] = "head_yaw";
  doc["accepted"] = true;
  doc["angle"] = acceptedAngle;
  doc["requested_angle"] = requestedAngle;
  doc["current_angle"] = gimbalPulseToAngle(
      currentHeadYawPulse, HEAD_YAW_MAX_ANGLE, headYawZeroPulse,
      headYawDirection, true);
  doc["clamped"] = fabs(requestedAngle - acceptedAngle) > 0.001;
  doc["duration_ms"] = acceptedDuration;
  doc["requested_duration_ms"] = rawDuration;
  doc["duration_clamped"] = fabs(rawDuration - acceptedDuration) > 0.5;
  doc["easing"] = acceptedEasing;
  doc["min_angle"] = 0;
  doc["max_angle"] = HEAD_YAW_MAX_ANGLE;
  doc["unit"] = "degree";
  doc["label"] = acceptedLabel;
  sendJsonEvent(doc);
}

void handleHeadPitchCommand(JsonObjectConst root) {
  const JsonVariantConst requestId = root["id"];
  const JsonVariantConst angleValue = root["angle"];

  if (!hasPitchMovementAuthority(root)) {
    Serial.println("[SAFE] Pitch command rejected: no authorized source");
    sendError("head_pitch",
              "Pitch movement requires user_command authority",
              requestId);
    return;
  }

  if (!isStrictNumber(angleValue) || !isFiniteNumber(angleValue.as<double>())) {
    sendError("head_pitch", "angle must be numeric", requestId);
    return;
  }

  const double requestedAngle = angleValue.as<double>();
  const float acceptedAngle = clampGimbalAngle(requestedAngle, HEAD_PITCH_MAX_ANGLE);
  const uint16_t targetPulse = gimbalAngleToPulse(
      acceptedAngle, HEAD_PITCH_MAX_ANGLE, headPitchZeroPulse,
      headPitchDirection, false);
  const JsonVariantConst durationValue = root["duration_ms"];
  double rawDuration = HEAD_PITCH_DEFAULT_DURATION_MS;

  if (!durationValue.isNull() && isStrictNumber(durationValue) &&
      isFiniteNumber(durationValue.as<double>())) {
    rawDuration = durationValue.as<double>();
  }

  const uint32_t acceptedDuration = clampHeadPitchDuration(rawDuration);
  const char *acceptedEasing = normalizeHeadPitchEasing(root["easing"]);
  char acceptedLabel[48] = "";
  sanitizeLabel(root["label"].is<const char *>() ? root["label"].as<const char *>()
                                                 : "head_pitch",
                acceptedLabel, sizeof(acceptedLabel));

  updateHeadPitchMotion(true);
  startHeadPitchTransition(targetPulse, acceptedDuration, acceptedEasing,
                           acceptedLabel);
  lastCommandAt = millis();

  StaticJsonDocument<512> doc;
  addRequestId(doc, requestId);
  doc["type"] = "ack";
  doc["cmd"] = "head_pitch";
  doc["accepted"] = true;
  doc["angle"] = acceptedAngle;
  doc["requested_angle"] = requestedAngle;
  doc["current_angle"] = gimbalPulseToAngle(
      currentHeadPitchPulse, HEAD_PITCH_MAX_ANGLE, headPitchZeroPulse,
      headPitchDirection, false);
  doc["clamped"] = fabs(requestedAngle - acceptedAngle) > 0.001;
  doc["duration_ms"] = acceptedDuration;
  doc["requested_duration_ms"] = rawDuration;
  doc["duration_clamped"] = fabs(rawDuration - acceptedDuration) > 0.5;
  doc["easing"] = acceptedEasing;
  doc["min_angle"] = 0;
  doc["max_angle"] = HEAD_PITCH_MAX_ANGLE;
  doc["unit"] = "degree";
  doc["label"] = acceptedLabel;
  sendJsonEvent(doc);
}

void handleGimbalMoveCommand(JsonObjectConst root) {
  const JsonVariantConst requestId = root["id"];
  const JsonVariantConst directionValue = root["direction"];

  if (!directionValue.is<const char *>()) {
    sendError("gimbal_move", "direction must be left, right, up, down, or center",
              requestId);
    return;
  }

  const char *direction = directionValue.as<const char *>();
  const bool isLeft = strcmp(direction, "left") == 0;
  const bool isRight = strcmp(direction, "right") == 0;
  const bool isUp = strcmp(direction, "up") == 0;
  const bool isDown = strcmp(direction, "down") == 0;
  const bool isCenter = strcmp(direction, "center") == 0;

  if (!isLeft && !isRight && !isUp && !isDown && !isCenter) {
    sendError("gimbal_move", "direction must be left, right, up, down, or center",
              requestId);
    return;
  }

  // A center command moves both axes, so it needs the same authorization as
  // an explicit up/down move. Left/right never energize the pitch servo.
  if ((isUp || isDown || isCenter) && !hasPitchMovementAuthority(root)) {
    Serial.println("[SAFE] Pitch gimbal move rejected: no authorized source");
    sendError("gimbal_move",
              "Pitch movement requires user_command authority",
              requestId);
    return;
  }

  const JsonVariantConst degreesValue = root["degrees"];
  double requestedDegrees = GIMBAL_NUDGE_DEFAULT_DEGREES;
  if (!degreesValue.isNull() && isStrictNumber(degreesValue) &&
      isFiniteNumber(degreesValue.as<double>())) {
    requestedDegrees = degreesValue.as<double>();
  }
  const float acceptedDegrees = clampGimbalNudgeDegrees(requestedDegrees);
  const JsonVariantConst durationValue = root["duration_ms"];
  double rawDuration = HEAD_PITCH_DEFAULT_DURATION_MS;
  if (!durationValue.isNull() && isStrictNumber(durationValue) &&
      isFiniteNumber(durationValue.as<double>())) {
    rawDuration = durationValue.as<double>();
  }
  const uint32_t acceptedDuration = clampHeadPitchDuration(rawDuration);
  const char *acceptedEasing = normalizeHeadPitchEasing(root["easing"]);
  char acceptedLabel[48] = "";
  sanitizeLabel(root["label"].is<const char *>() ? root["label"].as<const char *>()
                                                   : "gimbal_move",
                acceptedLabel, sizeof(acceptedLabel));

  if (isCenter || isLeft || isRight) {
    const uint16_t target = isCenter
                                ? headYawZeroPulse
                                : gimbalNudgePulse(
                                      currentHeadYawPulse, acceptedDegrees,
                                      HEAD_YAW_MAX_ANGLE,
                                      isLeft ? HEAD_YAW_LEFT_PULSE_SIGN
                                             : -HEAD_YAW_LEFT_PULSE_SIGN,
                                      true);
    updateHeadYawMotion(true);
    startHeadYawTransition(target, acceptedDuration, acceptedEasing, acceptedLabel);
  }

  if (isCenter || isUp || isDown) {
    const uint16_t target = isCenter
                                ? headPitchZeroPulse
                                : gimbalNudgePulse(
                                      currentHeadPitchPulse, acceptedDegrees,
                                      HEAD_PITCH_MAX_ANGLE,
                                      isUp ? HEAD_PITCH_UP_PULSE_SIGN
                                           : -HEAD_PITCH_UP_PULSE_SIGN,
                                      false);
    updateHeadPitchMotion(true);
    startHeadPitchTransition(target, acceptedDuration, acceptedEasing, acceptedLabel);
  }

  lastCommandAt = millis();
  StaticJsonDocument<384> doc;
  addRequestId(doc, requestId);
  doc["type"] = "ack";
  doc["cmd"] = "gimbal_move";
  doc["accepted"] = true;
  doc["direction"] = direction;
  doc["degrees"] = isCenter ? 0 : acceptedDegrees;
  doc["duration_ms"] = acceptedDuration;
  doc["label"] = acceptedLabel;
  doc["yaw_angle"] = gimbalPulseToAngle(currentHeadYawPulse, HEAD_YAW_MAX_ANGLE,
                                           headYawZeroPulse, headYawDirection,
                                           true);
  doc["pitch_angle"] = gimbalPulseToAngle(
      currentHeadPitchPulse, HEAD_PITCH_MAX_ANGLE, headPitchZeroPulse,
      headPitchDirection, false);
  sendJsonEvent(doc);
}

void handleGimbalZeroCommand(JsonObjectConst root) {
  const JsonVariantConst requestId = root["id"];
  captureGimbalZero("command");
  lastCommandAt = millis();

  StaticJsonDocument<192> doc;
  addRequestId(doc, requestId);
  doc["type"] = "ack";
  doc["cmd"] = "gimbal_zero";
  doc["accepted"] = true;
  doc["yaw_angle"] = 0;
  doc["pitch_angle"] = 0;
  sendJsonEvent(doc);
}

void handleStopCommand(JsonObjectConst root) {
  const JsonVariantConst requestId = root["id"];
  const char *reason = "stop_command";

  if (root["reason"].is<const char *>()) {
    reason = root["reason"].as<const char *>();
  }

  lastCommandAt = millis();
  Serial.printf("[CMD] Stop command received reason=%s\n", reason);
  stopMotors(reason);
  stopHeadMotion(reason);
  sendAck("stop", requestId, reason);
}

void handleConfigUpdateCommand(JsonObjectConst root) {
  const JsonVariantConst requestId = root["id"];
  StaticJsonDocument<JSON_DOC_SIZE> doc;
  addRequestId(doc, requestId);
  doc["type"] = "ack";
  doc["cmd"] = "config_update";
  doc["accepted"] = true;
  JsonArray warnings = doc.createNestedArray("warnings");

  if (root.containsKey("max_speed")) {
    const JsonVariantConst value = root["max_speed"];
    if (isStrictNumber(value) && isFiniteNumber(value.as<double>())) {
      const double requested = value.as<double>();
      runtimeMaxSpeed = constrain(static_cast<float>(requested), 0.05f,
                                  FIRMWARE_HARD_MAX_SPEED);
      addConfigWarnings(warnings, "max_speed", requested, runtimeMaxSpeed);
    } else {
      warnings.add("max_speed_invalid");
    }
  }

  if (root.containsKey("left_trim")) {
    const JsonVariantConst value = root["left_trim"];
    if (isStrictNumber(value) && isFiniteNumber(value.as<double>())) {
      const double requested = value.as<double>();
      leftTrim = constrain(static_cast<float>(requested), 0.5f, 1.3f);
      addConfigWarnings(warnings, "left_trim", requested, leftTrim);
    } else {
      warnings.add("left_trim_invalid");
    }
  }

  if (root.containsKey("right_trim")) {
    const JsonVariantConst value = root["right_trim"];
    if (isStrictNumber(value) && isFiniteNumber(value.as<double>())) {
      const double requested = value.as<double>();
      rightTrim = constrain(static_cast<float>(requested), 0.5f, 1.3f);
      addConfigWarnings(warnings, "right_trim", requested, rightTrim);
    } else {
      warnings.add("right_trim_invalid");
    }
  }

  if (root.containsKey("deadband")) {
    const JsonVariantConst value = root["deadband"];
    if (isStrictNumber(value) && isFiniteNumber(value.as<double>())) {
      const double requested = value.as<double>();
      runtimeDeadband = constrain(static_cast<float>(requested), 0.0f, 0.12f);
      addConfigWarnings(warnings, "deadband", requested, runtimeDeadband);
    } else {
      warnings.add("deadband_invalid");
    }
  }

  if (root.containsKey("default_ramp_ms")) {
    const JsonVariantConst value = root["default_ramp_ms"];
    if (isStrictNumber(value) && isFiniteNumber(value.as<double>())) {
      const double requested = value.as<double>();
      defaultRampMs = clampRamp(requested, MAX_DURATION_MS * 2);
      addConfigWarnings(warnings, "default_ramp_ms", requested, defaultRampMs);
    } else {
      warnings.add("default_ramp_ms_invalid");
    }
  }

  if (root.containsKey("min_pwm")) {
    const JsonVariantConst value = root["min_pwm"];
    if (isStrictNumber(value) && isFiniteNumber(value.as<double>())) {
      const double requested = value.as<double>();
      minPwm = clampMinPwm(requested);
      addConfigWarnings(warnings, "min_pwm", requested, minPwm);
    } else {
      warnings.add("min_pwm_invalid");
    }
  }

  targetLeftSpeed = clampSpeed(targetLeftSpeed);
  targetRightSpeed = clampSpeed(targetRightSpeed);
  currentLeftSpeed = clampSpeed(currentLeftSpeed);
  currentRightSpeed = clampSpeed(currentRightSpeed);
  applyMotorSpeeds(currentLeftSpeed, currentRightSpeed);

  JsonObject config = doc.createNestedObject("config");
  addConfig(config);

  Serial.printf(
      "[CFG] max=%.3f left_trim=%.3f right_trim=%.3f deadband=%.3f ramp=%lu "
      "min_pwm=%u warnings=%u\n",
      runtimeMaxSpeed, leftTrim, rightTrim, runtimeDeadband,
      static_cast<unsigned long>(defaultRampMs), minPwm, warnings.size());

  lastCommandAt = millis();
  sendJsonEvent(doc);
}

void handleConfigGetCommand(JsonObjectConst root) {
  const JsonVariantConst requestId = root["id"];
  lastCommandAt = millis();
  sendConfig(requestId);
}

void sendTelemetry() {
  if (connectedClientCount == 0) {
    return;
  }

  const uint32_t now = millis();
  StaticJsonDocument<JSON_DOC_SIZE> doc;

  doc["type"] = "telemetry";
  doc["uptime_ms"] = now;
  doc["transport"] = "ble";
  doc["ble_connected"] = bleClientConnected;
  doc["clients"] = connectedClientCount;
  doc["battery"] = nullptr;
  doc["motor_state"] = motorState();
  doc["left_speed"] = currentLeftSpeed;
  doc["right_speed"] = currentRightSpeed;
  doc["current_left_speed"] = currentLeftSpeed;
  doc["current_right_speed"] = currentRightSpeed;
  doc["target_left_speed"] = targetLeftSpeed;
  doc["target_right_speed"] = targetRightSpeed;
  doc["ramp_ms"] = motionRampMs;
  doc["motion_label"] = motionLabel;
  doc["motion_remaining_ms"] = motionRemainingMs(now);
  doc["last_command_age_ms"] =
      lastCommandAt == 0 ? 0 : static_cast<uint32_t>(now - lastCommandAt);

  JsonObject limits = doc.createNestedObject("limits");
  limits["max_speed"] = runtimeMaxSpeed;
  limits["hard_max_speed"] = FIRMWARE_HARD_MAX_SPEED;
  limits["max_duration_ms"] = MAX_DURATION_MS;

  JsonObject config = doc.createNestedObject("config");
  addConfig(config);

  sendJsonEvent(doc);
}

void sendConfig(JsonVariantConst requestId) {
  StaticJsonDocument<JSON_DOC_SIZE> doc;
  addRequestId(doc, requestId);
  doc["type"] = "config";
  JsonObject config = doc.createNestedObject("config");
  addConfig(config);
  sendJsonEvent(doc);
}

void sendAck(const char *cmd, JsonVariantConst requestId) {
  StaticJsonDocument<128> doc;
  addRequestId(doc, requestId);
  doc["type"] = "ack";
  doc["cmd"] = cmd;
  doc["accepted"] = true;
  sendJsonEvent(doc);
}

void sendAck(const char *cmd, JsonVariantConst requestId, const char *reason) {
  StaticJsonDocument<160> doc;
  addRequestId(doc, requestId);
  doc["type"] = "ack";
  doc["cmd"] = cmd;
  doc["accepted"] = true;
  doc["reason"] = reason;
  sendJsonEvent(doc);
}

void sendAck(const char *cmd, JsonVariantConst requestId, uint32_t durationMs,
             float leftSpeed, float rightSpeed, uint32_t rampMs,
             const char *label) {
  StaticJsonDocument<384> doc;
  addRequestId(doc, requestId);
  doc["type"] = "ack";
  doc["cmd"] = cmd;
  doc["accepted"] = true;
  doc["duration_ms"] = durationMs;
  doc["ramp_ms"] = rampMs;
  doc["label"] = label;
  doc["left_speed"] = leftSpeed;
  doc["right_speed"] = rightSpeed;
  sendJsonEvent(doc);
}

void sendError(const char *cmd, const char *message, JsonVariantConst requestId) {
  StaticJsonDocument<192> doc;
  addRequestId(doc, requestId);
  doc["type"] = "error";
  doc["cmd"] = cmd;
  doc["message"] = message;
  sendJsonEvent(doc);
}

void sendBleText(const String &message) {
  if (bleClientConnected && bleEventsCharacteristic) {
    for (size_t offset = 0; offset < message.length(); offset += BLE_NOTIFY_CHUNK_SIZE) {
      const size_t chunkLength =
          min(BLE_NOTIFY_CHUNK_SIZE, message.length() - offset);
      bleEventsCharacteristic->setValue(
          reinterpret_cast<const uint8_t *>(message.c_str() + offset),
          chunkLength);
      bleEventsCharacteristic->notify();
      delay(2);
    }
  }
}

void setDifferentialDrive(float leftSpeed, float rightSpeed, uint32_t durationMs,
                          uint32_t rampMs, const char *label) {
  const uint32_t now = millis();

  const float acceptedLeftSpeed =
      applyTrimAndClamp(applyDeadband(clampSpeed(leftSpeed)), leftTrim);
  const float acceptedRightSpeed =
      applyTrimAndClamp(applyDeadband(clampSpeed(rightSpeed)), rightTrim);

  lastCommandAt = now;

  if (fabsf(acceptedLeftSpeed) < 0.0001f &&
      fabsf(acceptedRightSpeed) < 0.0001f) {
    motionActive = false;
    motionEndAt = 0;
    targetLeftSpeed = 0.0f;
    targetRightSpeed = 0.0f;
    motionLabel[0] = '\0';
    applyMotorSpeeds(0.0f, 0.0f);
    return;
  }

  motionActive = true;
  rampingDown = false;
  motionStartAt = now;
  motionEndAt = now + durationMs;
  rampDownStartAt = 0;
  motionRampMs = clampRamp(rampMs, durationMs);
  startLeftSpeed = currentLeftSpeed;
  startRightSpeed = currentRightSpeed;
  targetLeftSpeed = acceptedLeftSpeed;
  targetRightSpeed = acceptedRightSpeed;
  sanitizeLabel(label, motionLabel, sizeof(motionLabel));

  Serial.printf("[MOTION] label=%s target_left=%.3f target_right=%.3f ramp=%lu\n",
                motionLabel, targetLeftSpeed, targetRightSpeed,
                static_cast<unsigned long>(motionRampMs));

  updateRampedMotion(true);
}

void updateRampedMotion(bool force) {
  if (!motionActive) {
    return;
  }

  const uint32_t now = millis();

  if (!force && now - lastMotorUpdateAt < MOTOR_UPDATE_INTERVAL_MS) {
    return;
  }

  lastMotorUpdateAt = now;

  if (!rampingDown && deadlineReached(now, motionEndAt)) {
    if (motionRampMs == 0) {
      Serial.println("[SAFE] Auto stop by duration");
      stopMotors("duration_timeout");
      return;
    }

    rampingDown = true;
    rampDownStartAt = now;
    startLeftSpeed = currentLeftSpeed;
    startRightSpeed = currentRightSpeed;
    targetLeftSpeed = 0.0f;
    targetRightSpeed = 0.0f;
    Serial.printf("[MOTION] Ramp down label=%s ramp=%lu\n", motionLabel,
                  static_cast<unsigned long>(motionRampMs));
  }

  const uint32_t rampStart = rampingDown ? rampDownStartAt : motionStartAt;
  const uint32_t elapsed = now - rampStart;
  const float progress = motionRampMs == 0
                             ? 1.0f
                             : constrain(static_cast<float>(elapsed) /
                                             static_cast<float>(motionRampMs),
                                         0.0f, 1.0f);
  const float nextLeft =
      startLeftSpeed + (targetLeftSpeed - startLeftSpeed) * progress;
  const float nextRight =
      startRightSpeed + (targetRightSpeed - startRightSpeed) * progress;

  applyMotorSpeeds(nextLeft, nextRight);

  if (rampingDown && progress >= 1.0f) {
    Serial.println("[SAFE] Auto stop after ramp down");
    stopMotors("duration_timeout");
  }
}

void updateHeadYawMotion(bool force) {
  if (!headYawMoving) {
    return;
  }

  const uint32_t now = millis();

  if (!force && now - headYawLastUpdateAt < HEAD_PITCH_UPDATE_INTERVAL_MS) {
    return;
  }

  headYawLastUpdateAt = now;

  if (headYawDurationMs == 0 || now - headYawStartAt >= headYawDurationMs) {
    writeHeadYawPulse(headYawTargetPulse);
    headYawMoving = false;
    if (HEAD_YAW_RELEASE_AFTER_MOVE && headYawPwmAttached) {
      idleServoPwm(HEAD_YAW_PWM_PIN, HEAD_YAW_PWM_CHANNEL);
    }
    Serial.printf("[HEAD] yaw complete pulse=%u easing=%s\n", currentHeadYawPulse,
                  headYawEasing);
    return;
  }

  const float progress = constrain(
      static_cast<float>(now - headYawStartAt) /
          static_cast<float>(headYawDurationMs),
      0.0f, 1.0f);
  const float easedProgress = easeHeadPitchProgress(progress, headYawEasing);
  const float nextPulse =
      static_cast<float>(headYawStartPulse) +
      (static_cast<float>(headYawTargetPulse) -
       static_cast<float>(headYawStartPulse)) *
          easedProgress;

  writeHeadYawPulse(static_cast<uint16_t>(lroundf(nextPulse)));
}

void updateHeadPitchMotion(bool force) {
  if (!headPitchMoving) {
    return;
  }

  const uint32_t now = millis();

  if (!force && now - headPitchLastUpdateAt < HEAD_PITCH_UPDATE_INTERVAL_MS) {
    return;
  }

  headPitchLastUpdateAt = now;

  if (headPitchDurationMs == 0 ||
      now - headPitchStartAt >= headPitchDurationMs) {
    writeHeadPitchPulse(headPitchTargetPulse);
    headPitchMoving = false;
    if (HEAD_PITCH_RELEASE_AFTER_MOVE && headPitchPwmAttached) {
      idleServoPwm(HEAD_PITCH_PWM_PIN, HEAD_PITCH_PWM_CHANNEL);
    }
    Serial.printf("[HEAD] pitch complete pulse=%u easing=%s\n",
                  currentHeadPitchPulse, headPitchEasing);
    return;
  }

  const float progress = constrain(
      static_cast<float>(now - headPitchStartAt) /
          static_cast<float>(headPitchDurationMs),
      0.0f, 1.0f);
  const float easedProgress = easeHeadPitchProgress(progress, headPitchEasing);
  const float nextPulse =
      static_cast<float>(headPitchStartPulse) +
      (static_cast<float>(headPitchTargetPulse) -
       static_cast<float>(headPitchStartPulse)) *
           easedProgress;
  writeHeadPitchPulse(static_cast<uint16_t>(lroundf(nextPulse)));
}

void applyMotorSpeeds(float leftSpeed, float rightSpeed) {
  currentLeftSpeed = applyDeadband(clampSpeed(leftSpeed));
  currentRightSpeed = applyDeadband(clampSpeed(rightSpeed));

  const bool motorEnabled = fabsf(currentLeftSpeed) >= 0.0001f ||
                            fabsf(currentRightSpeed) >= 0.0001f;
  digitalWrite(TB6612_STBY, motorEnabled ? HIGH : LOW);

  setMotorSide(TB6612_AIN1, TB6612_AIN2, LEFT_WHEEL_PWM_PIN,
               currentLeftSpeed * static_cast<float>(LEFT_DRIVE_SIGN),
               LEFT_INVERT, LEFT_PWM_CHANNEL);
  setMotorSide(TB6612_BIN1, TB6612_BIN2, RIGHT_WHEEL_PWM_PIN,
               currentRightSpeed * static_cast<float>(RIGHT_DRIVE_SIGN),
               RIGHT_INVERT, RIGHT_PWM_CHANNEL);
}

void setMotorSide(uint8_t in1Pin, uint8_t in2Pin, uint8_t enablePin, float speed,
                  bool invert, uint8_t pwmChannel) {
  const float effectiveSpeed = invert ? -speed : speed;
  uint32_t duty = static_cast<uint32_t>(
      roundf(fabsf(effectiveSpeed) * static_cast<float>(PWM_MAX_DUTY)));

  if (fabsf(effectiveSpeed) < 0.0001f) {
    digitalWrite(in1Pin, LOW);
    digitalWrite(in2Pin, LOW);
    writeMotorPwm(enablePin, pwmChannel, 0);
    return;
  }

  if (minPwm > 0 && duty > 0) {
    duty = max(static_cast<uint32_t>(minPwm), duty);
  }

  if (effectiveSpeed > 0.0f) {
    digitalWrite(in1Pin, HIGH);
    digitalWrite(in2Pin, LOW);
  } else {
    digitalWrite(in1Pin, LOW);
    digitalWrite(in2Pin, HIGH);
  }

  writeMotorPwm(enablePin, pwmChannel, duty);
}

bool attachMotorPwm(uint8_t pin, uint8_t channel) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  return ledcAttach(pin, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS);
#else
  ledcSetup(channel, PWM_FREQUENCY_HZ, PWM_RESOLUTION_BITS);
  ledcAttachPin(pin, channel);
  return true;
#endif
}

void writeMotorPwm(uint8_t pin, uint8_t channel, uint32_t duty) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(pin, duty);
#else
  ledcWrite(channel, duty);
#endif
}

bool attachServoPwm(uint8_t pin, uint8_t channel) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  return ledcAttach(pin, HEAD_SERVO_FREQUENCY_HZ,
                    HEAD_SERVO_PWM_RESOLUTION_BITS);
#else
  ledcSetup(channel, HEAD_SERVO_FREQUENCY_HZ, HEAD_SERVO_PWM_RESOLUTION_BITS);
  ledcAttachPin(pin, channel);
  return true;
#endif
}

bool ensureHeadServoPwmAttached(bool yawAxis) {
  bool &attached = yawAxis ? headYawPwmAttached : headPitchPwmAttached;
  if (attached) {
    return true;
  }

  const uint8_t pin = yawAxis ? HEAD_YAW_PWM_PIN : HEAD_PITCH_PWM_PIN;
  const uint8_t channel =
      yawAxis ? HEAD_YAW_PWM_CHANNEL : HEAD_PITCH_PWM_CHANNEL;
  attached = attachServoPwm(pin, channel);
  if (attached) {
    idleServoPwm(pin, channel);
    Serial.printf("[HEAD] %s servo PWM attached on GPIO%u\n",
                  yawAxis ? "yaw" : "pitch", pin);
  } else {
    Serial.printf("[HEAD] Failed to attach %s servo PWM on GPIO%u\n",
                  yawAxis ? "yaw" : "pitch", pin);
  }

  return attached;
}

void idleServoPwm(uint8_t pin, uint8_t channel) {
#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(pin, 0);
#else
  ledcWrite(channel, 0);
#endif
}

void writeServoPwm(uint8_t pin, uint8_t channel, uint16_t pulseWidthUs) {
  const uint32_t duty = static_cast<uint32_t>(lroundf(
      static_cast<float>(pulseWidthUs) /
      static_cast<float>(HEAD_SERVO_PERIOD_US) *
      static_cast<float>(HEAD_SERVO_PWM_MAX_DUTY)));

#if defined(ESP_ARDUINO_VERSION_MAJOR) && ESP_ARDUINO_VERSION_MAJOR >= 3
  ledcWrite(pin, duty);
#else
  ledcWrite(channel, duty);
#endif
}

void writeHeadYawPulse(uint16_t pulse) {
  if (!ensureHeadServoPwmAttached(true)) {
    return;
  }
  currentHeadYawPulse = clampHeadYawPulse(pulse);
  writeServoPwm(HEAD_YAW_PWM_PIN, HEAD_YAW_PWM_CHANNEL, currentHeadYawPulse);
}

void writeHeadPitchPulse(uint16_t pulse) {
  if (!ensureHeadServoPwmAttached(false)) {
    return;
  }
  currentHeadPitchPulse = clampHeadPitchPulse(pulse);
  writeServoPwm(HEAD_PITCH_PWM_PIN, HEAD_PITCH_PWM_CHANNEL,
                currentHeadPitchPulse);
}

void setHeadYawImmediate(uint16_t pulse, const char *label) {
  headYawMoving = false;
  headYawStartPulse = currentHeadYawPulse;
  headYawTargetPulse = clampHeadYawPulse(pulse);
  headYawDurationMs = 0;
  writeHeadYawPulse(headYawTargetPulse);
  if (HEAD_YAW_RELEASE_AFTER_MOVE && headYawPwmAttached) {
    idleServoPwm(HEAD_YAW_PWM_PIN, HEAD_YAW_PWM_CHANNEL);
  }

  Serial.printf("[HEAD] yaw immediate pulse=%u label=%s\n", currentHeadYawPulse,
                label && strlen(label) > 0 ? label : "head_yaw");
}

void setHeadPitchImmediate(uint16_t pulse, const char *label) {
  headPitchMoving = false;
  headPitchStartPulse = currentHeadPitchPulse;
  headPitchTargetPulse = clampHeadPitchPulse(pulse);
  headPitchDurationMs = 0;
  writeHeadPitchPulse(headPitchTargetPulse);
  if (HEAD_PITCH_RELEASE_AFTER_MOVE && headPitchPwmAttached) {
    idleServoPwm(HEAD_PITCH_PWM_PIN, HEAD_PITCH_PWM_CHANNEL);
  }

  Serial.printf("[HEAD] pitch immediate pulse=%u label=%s\n",
                currentHeadPitchPulse,
                label && strlen(label) > 0 ? label : "head_pitch");
}

void startHeadYawTransition(uint16_t targetPulse, uint32_t durationMs,
                            const char *easing, const char *label) {
  const uint16_t acceptedTarget = clampHeadYawPulse(targetPulse);
  const uint32_t acceptedDuration = clampHeadPitchDuration(durationMs);
  const char *acceptedEasing = easing && strlen(easing) > 0
                                   ? easing
                                   : HEAD_PITCH_DEFAULT_EASING;

  if (acceptedDuration == 0 || acceptedTarget == currentHeadYawPulse) {
    setHeadYawImmediate(acceptedTarget, label);
    return;
  }

  headYawStartPulse = currentHeadYawPulse;
  headYawTargetPulse = acceptedTarget;
  headYawStartAt = millis();
  headYawDurationMs = acceptedDuration;
  headYawLastUpdateAt = 0;
  headYawMoving = true;
  strncpy(headYawEasing, acceptedEasing, sizeof(headYawEasing) - 1);
  headYawEasing[sizeof(headYawEasing) - 1] = '\0';

  Serial.printf(
      "[HEAD] yaw transition start=%u target=%u duration=%lu easing=%s label=%s\n",
      headYawStartPulse, headYawTargetPulse,
      static_cast<unsigned long>(headYawDurationMs), headYawEasing,
      label && strlen(label) > 0 ? label : "head_yaw");

  updateHeadYawMotion(true);
}

void startHeadPitchTransition(uint16_t targetPulse, uint32_t durationMs,
                              const char *easing, const char *label) {
  const uint16_t acceptedTarget = clampHeadPitchPulse(targetPulse);
  const uint32_t acceptedDuration = clampHeadPitchDuration(durationMs);
  const char *acceptedEasing = easing && strlen(easing) > 0
                                   ? easing
                                   : HEAD_PITCH_DEFAULT_EASING;

  if (acceptedTarget == currentHeadPitchPulse) {
    setHeadPitchImmediate(acceptedTarget, label);
    return;
  }

  if (acceptedDuration == 0) {
    setHeadPitchImmediate(acceptedTarget, label);
    return;
  }

  headPitchStartPulse = currentHeadPitchPulse;
  headPitchTargetPulse = acceptedTarget;
  headPitchStartAt = millis();
  headPitchDurationMs = acceptedDuration;
  headPitchLastUpdateAt = 0;
  headPitchMoving = true;
  strncpy(headPitchEasing, acceptedEasing, sizeof(headPitchEasing) - 1);
  headPitchEasing[sizeof(headPitchEasing) - 1] = '\0';

  Serial.printf(
      "[HEAD] pitch transition start=%u target=%u duration=%lu easing=%s "
      "label=%s\n",
      headPitchStartPulse, headPitchTargetPulse,
      static_cast<unsigned long>(headPitchDurationMs), headPitchEasing,
      label && strlen(label) > 0 ? label : "head_pitch");

  updateHeadPitchMotion(true);
}

void stopHeadMotion(const char *reason) {
  headYawMoving = false;
  headPitchMoving = false;
  headYawStartPulse = currentHeadYawPulse;
  headYawTargetPulse = currentHeadYawPulse;
  headPitchStartPulse = currentHeadPitchPulse;
  headPitchTargetPulse = currentHeadPitchPulse;
  if (headYawPwmAttached) {
    idleServoPwm(HEAD_YAW_PWM_PIN, HEAD_YAW_PWM_CHANNEL);
  }
  if (headPitchPwmAttached) {
    idleServoPwm(HEAD_PITCH_PWM_PIN, HEAD_PITCH_PWM_CHANNEL);
  }

  Serial.printf("[SAFE] Gimbal PWM disabled: %s\n",
                reason && strlen(reason) > 0 ? reason : "stop");
}

void stopMotors(const char *reason) {
  const bool wasMoving = motionActive || !isStopped();

  motionActive = false;
  rampingDown = false;
  motionEndAt = 0;
  rampDownStartAt = 0;
  startLeftSpeed = 0.0f;
  startRightSpeed = 0.0f;
  targetLeftSpeed = 0.0f;
  targetRightSpeed = 0.0f;
  motionLabel[0] = '\0';
  applyMotorSpeeds(0.0f, 0.0f);

  if (wasMoving) {
    Serial.printf("[SAFE] Motor stop: %s\n", reason);
  }
}

void addConfig(JsonObject target) {
  target["max_speed"] = runtimeMaxSpeed;
  target["hard_max_speed"] = FIRMWARE_HARD_MAX_SPEED;
  target["left_trim"] = leftTrim;
  target["right_trim"] = rightTrim;
  target["deadband"] = runtimeDeadband;
  target["default_ramp_ms"] = defaultRampMs;
  target["min_pwm"] = minPwm;

  JsonObject yaw = target.createNestedObject("head_yaw");
  yaw["gpio"] = HEAD_YAW_PWM_PIN;
  yaw["angle"] = gimbalPulseToAngle(
      currentHeadYawPulse, HEAD_YAW_MAX_ANGLE, headYawZeroPulse,
      headYawDirection, true);
  yaw["min_angle"] = 0;
  yaw["max_angle"] = HEAD_YAW_MAX_ANGLE;
  yaw["zero_angle"] = 0;
  yaw["safe_min_pulse_us"] = HEAD_YAW_SAFE_MIN_PULSE;
  yaw["safe_max_pulse_us"] = HEAD_YAW_SAFE_MAX_PULSE;
  yaw["release_after_move"] = HEAD_YAW_RELEASE_AFTER_MOVE;
  yaw["default_duration_ms"] = HEAD_PITCH_DEFAULT_DURATION_MS;
  yaw["max_duration_ms"] = HEAD_PITCH_MAX_DURATION_MS;
  yaw["update_interval_ms"] = HEAD_PITCH_UPDATE_INTERVAL_MS;
  yaw["moving"] = headYawMoving;
  yaw["target_angle"] = gimbalPulseToAngle(
      headYawTargetPulse, HEAD_YAW_MAX_ANGLE, headYawZeroPulse,
      headYawDirection, true);
  yaw["duration_ms"] = headYawDurationMs;
  yaw["easing"] = headYawEasing;
  yaw["unit"] = "degree";

  JsonObject head = target.createNestedObject("head_pitch");
  head["gpio"] = HEAD_PITCH_PWM_PIN;
  head["angle"] = gimbalPulseToAngle(
      currentHeadPitchPulse, HEAD_PITCH_MAX_ANGLE, headPitchZeroPulse,
      headPitchDirection, false);
  head["min_angle"] = 0;
  head["max_angle"] = HEAD_PITCH_MAX_ANGLE;
  head["zero_angle"] = 0;
  head["safe_min_pulse_us"] = HEAD_PITCH_SAFE_MIN_PULSE;
  head["safe_max_pulse_us"] = HEAD_PITCH_SAFE_MAX_PULSE;
  head["continuous_rotation"] = false;
  head["movement_authority_required"] = true;
  JsonArray pitchAuthorities = head.createNestedArray("movement_authorities");
  pitchAuthorities.add(PITCH_AUTHORITY_USER_COMMAND);
  head["release_after_move"] = HEAD_PITCH_RELEASE_AFTER_MOVE;
  head["default_duration_ms"] = HEAD_PITCH_DEFAULT_DURATION_MS;
  head["max_duration_ms"] = HEAD_PITCH_MAX_DURATION_MS;
  head["update_interval_ms"] = HEAD_PITCH_UPDATE_INTERVAL_MS;
  head["moving"] = headPitchMoving;
  head["target_angle"] = gimbalPulseToAngle(
      headPitchTargetPulse, HEAD_PITCH_MAX_ANGLE, headPitchZeroPulse,
      headPitchDirection, false);
  head["duration_ms"] = headPitchDurationMs;
  head["easing"] = headPitchEasing;
  JsonArray easingModes = head.createNestedArray("easing_modes");
  easingModes.add(HEAD_PITCH_DEFAULT_EASING);
  easingModes.add(HEAD_PITCH_EASE_OUT_CUBIC);
  easingModes.add(HEAD_PITCH_EASE_OUT_QUART);
  easingModes.add(HEAD_PITCH_EXPONENTIAL_SMOOTHING);
  easingModes.add(HEAD_PITCH_CRITICALLY_DAMPED_SPRING);
  easingModes.add(HEAD_PITCH_MINIMUM_JERK);
  head["unit"] = "degree";
}

void addConfigWarnings(JsonArray warnings, const char *field, double requested,
                       double accepted) {
  if (fabs(requested - accepted) <= 0.0001) {
    return;
  }

  char warning[48];
  snprintf(warning, sizeof(warning), "%s_clamped", field);
  warnings.add(warning);
  Serial.printf("[CFG] %s clamped %.3f -> %.3f\n", field, requested,
                accepted);
}

void sanitizeLabel(const char *input, char *output, size_t outputSize) {
  if (!output || outputSize == 0) {
    return;
  }

  const char *source = input && strlen(input) > 0 ? input : "motion";
  size_t index = 0;

  for (; source[index] != '\0' && index < outputSize - 1; index++) {
    const char value = source[index];
    const bool safeChar =
        (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z') ||
        (value >= '0' && value <= '9') || value == '_' || value == '-' ||
        value == '.';
    output[index] = safeChar
                        ? value
                        : '_';
  }

  output[index] = '\0';
}

bool isStrictNumber(JsonVariantConst value) {
  if (value.isNull() || value.is<const char *>() || value.is<bool>() ||
      value.is<JsonArrayConst>() || value.is<JsonObjectConst>()) {
    return false;
  }

  return value.is<int>() || value.is<unsigned int>() || value.is<long>() ||
         value.is<unsigned long>() || value.is<float>() || value.is<double>();
}

bool isFiniteNumber(double value) {
  return !isnan(value) && !isinf(value);
}

bool hasPitchMovementAuthority(JsonObjectConst root) {
  const JsonVariantConst authorityValue = root["pitch_authority"];
  if (!authorityValue.is<const char *>()) {
    return false;
  }

  const char *authority = authorityValue.as<const char *>();
  return strcmp(authority, PITCH_AUTHORITY_USER_COMMAND) == 0;
}

float clampSpeed(float value) {
  return constrain(value, -runtimeMaxSpeed, runtimeMaxSpeed);
}

float applyDeadband(float value) {
  return fabsf(value) < runtimeDeadband ? 0.0f : value;
}

float applyTrimAndClamp(float value, float trim) {
  return applyDeadband(clampSpeed(value * trim));
}

uint16_t clampHeadYawPulse(double pulse) {
  const double bounded =
      constrain(pulse, static_cast<double>(HEAD_YAW_SAFE_MIN_PULSE),
                static_cast<double>(HEAD_YAW_SAFE_MAX_PULSE));
  return static_cast<uint16_t>(lround(bounded));
}

uint16_t clampHeadPitchPulse(double pulse) {
  const double bounded =
      constrain(pulse, static_cast<double>(HEAD_PITCH_SAFE_MIN_PULSE),
                static_cast<double>(HEAD_PITCH_SAFE_MAX_PULSE));
  return static_cast<uint16_t>(lround(bounded));
}

float clampGimbalAngle(double angle, float maxAngle) {
  return constrain(static_cast<float>(angle), 0.0f, maxAngle);
}

uint16_t gimbalAngleToPulse(float angle, float maxAngle, uint16_t zeroPulse,
                            int8_t direction, bool yawAxis) {
  const float boundedAngle = clampGimbalAngle(angle, maxAngle);
  const uint16_t minPulse = yawAxis ? HEAD_YAW_SAFE_MIN_PULSE
                                    : HEAD_PITCH_SAFE_MIN_PULSE;
  const uint16_t maxPulse = yawAxis ? HEAD_YAW_SAFE_MAX_PULSE
                                    : HEAD_PITCH_SAFE_MAX_PULSE;
  const float availableTravel = direction >= 0
                                     ? maxPulse - zeroPulse
                                     : zeroPulse - minPulse;
  const float offset = maxAngle <= 0.0f
                            ? 0.0f
                            : boundedAngle / maxAngle * availableTravel;
  const double target = direction >= 0 ? zeroPulse + offset : zeroPulse - offset;
  return yawAxis ? clampHeadYawPulse(target) : clampHeadPitchPulse(target);
}

float gimbalPulseToAngle(uint16_t pulse, float maxAngle, uint16_t zeroPulse,
                          int8_t direction, bool yawAxis) {
  const uint16_t minPulse = yawAxis ? HEAD_YAW_SAFE_MIN_PULSE
                                    : HEAD_PITCH_SAFE_MIN_PULSE;
  const uint16_t maxPulse = yawAxis ? HEAD_YAW_SAFE_MAX_PULSE
                                    : HEAD_PITCH_SAFE_MAX_PULSE;
  const float availableTravel = direction >= 0
                                     ? maxPulse - zeroPulse
                                     : zeroPulse - minPulse;
  if (availableTravel <= 0.0f) {
    return 0.0f;
  }
  const float offset = direction >= 0 ? pulse - zeroPulse : zeroPulse - pulse;
  return clampGimbalAngle(offset / availableTravel * maxAngle, maxAngle);
}

uint16_t gimbalNudgePulse(uint16_t currentPulse, float degrees, float maxAngle,
                           int8_t pulseDirection, bool yawAxis) {
  const uint16_t minPulse = yawAxis ? HEAD_YAW_SAFE_MIN_PULSE
                                    : HEAD_PITCH_SAFE_MIN_PULSE;
  const uint16_t maxPulse = yawAxis ? HEAD_YAW_SAFE_MAX_PULSE
                                    : HEAD_PITCH_SAFE_MAX_PULSE;
  const float fullTravel = static_cast<float>(maxPulse - minPulse);
  const float pulseOffset = maxAngle <= 0.0f ? 0.0f : degrees / maxAngle * fullTravel;
  const double target = currentPulse + (pulseDirection >= 0 ? pulseOffset : -pulseOffset);
  return yawAxis ? clampHeadYawPulse(target) : clampHeadPitchPulse(target);
}

float clampGimbalNudgeDegrees(double degrees) {
  return constrain(static_cast<float>(degrees), 1.0f, GIMBAL_NUDGE_MAX_DEGREES);
}

void captureGimbalZero(const char *reason) {
  headYawMoving = false;
  headPitchMoving = false;
  if (headYawPwmAttached) {
    idleServoPwm(HEAD_YAW_PWM_PIN, HEAD_YAW_PWM_CHANNEL);
  }
  if (headPitchPwmAttached) {
    idleServoPwm(HEAD_PITCH_PWM_PIN, HEAD_PITCH_PWM_CHANNEL);
  }
  headYawStartPulse = currentHeadYawPulse;
  headYawTargetPulse = currentHeadYawPulse;
  headPitchStartPulse = currentHeadPitchPulse;
  headPitchTargetPulse = currentHeadPitchPulse;
  headYawZeroPulse = currentHeadYawPulse;
  headPitchZeroPulse = currentHeadPitchPulse;

  const uint16_t yawPositiveTravel = HEAD_YAW_SAFE_MAX_PULSE - headYawZeroPulse;
  const uint16_t yawNegativeTravel = headYawZeroPulse - HEAD_YAW_SAFE_MIN_PULSE;
  headYawDirection = yawPositiveTravel >= yawNegativeTravel ? 1 : -1;
  const uint16_t pitchPositiveTravel = HEAD_PITCH_SAFE_MAX_PULSE - headPitchZeroPulse;
  const uint16_t pitchNegativeTravel = headPitchZeroPulse - HEAD_PITCH_SAFE_MIN_PULSE;
  headPitchDirection = pitchPositiveTravel >= pitchNegativeTravel ? 1 : -1;

  Serial.printf("[HEAD] connection zero captured yaw=0 pitch=0 reason=%s\n",
                reason ? reason : "unknown");
}

uint32_t clampHeadPitchDuration(double durationMs) {
  const double bounded =
      constrain(durationMs, 0.0, static_cast<double>(HEAD_PITCH_MAX_DURATION_MS));
  return static_cast<uint32_t>(lround(bounded));
}

const char *normalizeHeadPitchEasing(JsonVariantConst value) {
  if (!value.is<const char *>()) {
    return HEAD_PITCH_DEFAULT_EASING;
  }

  const char *requested = value.as<const char *>();

  if (!requested) {
    return HEAD_PITCH_DEFAULT_EASING;
  }

  if (strcmp(requested, HEAD_PITCH_DEFAULT_EASING) == 0) {
    return HEAD_PITCH_DEFAULT_EASING;
  }

  if (strcmp(requested, HEAD_PITCH_EASE_OUT_CUBIC) == 0) {
    return HEAD_PITCH_EASE_OUT_CUBIC;
  }

  if (strcmp(requested, HEAD_PITCH_EASE_OUT_QUART) == 0) {
    return HEAD_PITCH_EASE_OUT_QUART;
  }

  if (strcmp(requested, HEAD_PITCH_EXPONENTIAL_SMOOTHING) == 0) {
    return HEAD_PITCH_EXPONENTIAL_SMOOTHING;
  }

  if (strcmp(requested, HEAD_PITCH_CRITICALLY_DAMPED_SPRING) == 0) {
    return HEAD_PITCH_CRITICALLY_DAMPED_SPRING;
  }

  if (strcmp(requested, HEAD_PITCH_MINIMUM_JERK) == 0) {
    return HEAD_PITCH_MINIMUM_JERK;
  }

  return HEAD_PITCH_DEFAULT_EASING;
}

float easeHeadPitchProgress(float progress, const char *easing) {
  const float t = constrain(progress, 0.0f, 1.0f);

  if (!easing || strcmp(easing, HEAD_PITCH_DEFAULT_EASING) == 0) {
    return t < 0.5f ? 4.0f * t * t * t
                    : 1.0f - powf(-2.0f * t + 2.0f, 3.0f) / 2.0f;
  }

  if (strcmp(easing, HEAD_PITCH_EASE_OUT_CUBIC) == 0) {
    const float inverse = 1.0f - t;
    return 1.0f - inverse * inverse * inverse;
  }

  if (strcmp(easing, HEAD_PITCH_EASE_OUT_QUART) == 0) {
    const float inverse = 1.0f - t;
    return 1.0f - inverse * inverse * inverse * inverse;
  }

  if (strcmp(easing, HEAD_PITCH_EXPONENTIAL_SMOOTHING) == 0) {
    constexpr float response = 5.0f;
    const float normalizedEnd = 1.0f - expf(-response);
    return (1.0f - expf(-response * t)) / normalizedEnd;
  }

  if (strcmp(easing, HEAD_PITCH_CRITICALLY_DAMPED_SPRING) == 0) {
    constexpr float response = 6.0f;
    const float value = 1.0f - (1.0f + response * t) * expf(-response * t);
    const float endValue = 1.0f - (1.0f + response) * expf(-response);
    return value / endValue;
  }

  if (strcmp(easing, HEAD_PITCH_MINIMUM_JERK) == 0) {
    const float t2 = t * t;
    const float t3 = t2 * t;
    return 10.0f * t3 - 15.0f * t3 * t + 6.0f * t3 * t2;
  }

  return t;
}

uint32_t clampDuration(double durationMs) {
  const double bounded =
      constrain(durationMs, static_cast<double>(MIN_DURATION_MS),
                static_cast<double>(MAX_DURATION_MS));
  return static_cast<uint32_t>(lround(bounded));
}

uint32_t clampRamp(double rampMs, uint32_t durationMs) {
  const double safeRamp = constrain(rampMs, 0.0, static_cast<double>(MAX_RAMP_MS));
  const uint32_t bounded = static_cast<uint32_t>(lround(safeRamp));
  const uint32_t maxForDuration = durationMs / 2;
  return bounded < maxForDuration ? bounded : maxForDuration;
}

uint8_t clampMinPwm(double value) {
  const double bounded =
      constrain(value, 0.0, static_cast<double>(MAX_SAFE_MIN_PWM));
  return static_cast<uint8_t>(lround(bounded));
}

bool isStopped() {
  return fabsf(currentLeftSpeed) < 0.0001f && fabsf(currentRightSpeed) < 0.0001f;
}

bool deadlineReached(uint32_t now, uint32_t deadline) {
  return static_cast<int32_t>(now - deadline) >= 0;
}

uint32_t motionRemainingMs(uint32_t now) {
  if (!motionActive) {
    return 0;
  }

  if (rampingDown) {
    const uint32_t rampEndAt = rampDownStartAt + motionRampMs;
    return deadlineReached(now, rampEndAt) ? 0 : rampEndAt - now;
  }

  return deadlineReached(now, motionEndAt) ? 0 : motionEndAt - now;
}

const char *motorState() {
  if (isStopped()) {
    return "stopped";
  }

  const float averageSpeed = (currentLeftSpeed + currentRightSpeed) * 0.5f;
  const float differentialSpeed =
      (currentRightSpeed - currentLeftSpeed) * 0.5f;

  if (fabsf(differentialSpeed) > runtimeDeadband &&
      fabsf(averageSpeed) <= runtimeDeadband) {
    return differentialSpeed > 0.0f ? "rotating_right" : "rotating_left";
  }

  if (fabsf(averageSpeed) > runtimeDeadband &&
      fabsf(differentialSpeed) <= runtimeDeadband) {
    return averageSpeed > 0.0f ? "moving_forward" : "moving_backward";
  }

  return "mixed";
}

void addRequestId(JsonDocument &doc, JsonVariantConst requestId) {
  if (requestId.isNull()) {
    return;
  }

  if (requestId.is<const char *>()) {
    doc["id"] = requestId.as<const char *>();
    return;
  }

  if (requestId.is<long>()) {
    doc["id"] = requestId.as<long>();
    return;
  }

  if (requestId.is<unsigned long>()) {
    doc["id"] = requestId.as<unsigned long>();
    return;
  }

  if (requestId.is<bool>()) {
    doc["id"] = requestId.as<bool>();
    return;
  }

  String fallback;
  serializeJson(requestId, fallback);
  doc["id"] = fallback;
}
