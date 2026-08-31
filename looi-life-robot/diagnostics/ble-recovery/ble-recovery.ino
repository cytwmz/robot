#include <Arduino.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>

constexpr char DEVICE_NAME[] = "LOOI-S3-RECOVERY";
constexpr char SERVICE_UUID[] = "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0001";
constexpr char COMMAND_UUID[] = "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0002";
constexpr char EVENTS_UUID[] = "7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0003";

BLEAdvertising *advertising = nullptr;

class RecoveryServerCallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer *server) override {
    (void)server;
    if (advertising) {
      advertising->start();
    }
  }
};

void setup() {
  Serial.begin(115200);
  delay(250);
  Serial.println("[RECOVERY] Starting standard ESP32 BLE stack");

  BLEDevice::init(DEVICE_NAME);
  BLEDevice::setPower(ESP_PWR_LVL_P9);

  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new RecoveryServerCallbacks());
  BLEService *service = server->createService(SERVICE_UUID);
  service->createCharacteristic(
      COMMAND_UUID,
      BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
  service->createCharacteristic(EVENTS_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  service->start();

  advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);
  advertising->start();
  Serial.printf("[RECOVERY] Advertising as %s\n", DEVICE_NAME);
}

void loop() {
  delay(1000);
}
