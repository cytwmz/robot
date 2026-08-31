# LOOI Life Robot

LOOI is a browser-first robot runtime. The website runs the face, camera,
conversation, personality, and behavior logic. The ESP32 body is optional and is
controlled directly from the user's browser over Web Bluetooth.

See `docs/open-source-looi-context.md` for the Gemini Live research notes and
the open-source LOOI architecture direction.

## Current Body Model

- No accounts.
- No robot tokens.
- No ESP32 IP address.
- No ESP32 Wi-Fi setup.
- No server-side ESP32 gateway.
- A user without hardware can choose **Skip and start without body**.
- A user with hardware flashes firmware, connects **LOOI Body** by Bluetooth,
  runs body tests, then starts LOOI.

This means a remote user cannot take over another user's body through the public
server. The browser must be physically near the ESP32 and paired through the
Bluetooth picker.

## Project Layout

- `frontend/`: browser app, firmware upload assets, Web Bluetooth body control.
- `backend/`: Node API server and Qwen-Omni Realtime relay.
- `src/`: ESP32 firmware source.

## Run The Backend Locally

```sh
cd backend
npm install
npm run dev
```

With `SERVE_FRONTEND=true`, the backend can also serve `../frontend` for local
testing. Public frontend deployments must use HTTPS for Web Bluetooth and Web
Serial firmware upload.

## Gemini Live Through A Relay

To use `gemini-3.1-flash-live-preview` through a middle station, fill these
fields in `backend/.env` and restart the backend:

```dotenv
GEMINI_LIVE_ENABLED=true
GEMINI_API_KEY=
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
GEMINI_LIVE_WEBSOCKET_URL=
GEMINI_LIVE_AUTH_MODE=query
GEMINI_LIVE_API_KEY_QUERY_PARAM=key
```

`GEMINI_LIVE_WEBSOCKET_URL` must be the complete Gemini Live WebSocket endpoint
provided by the middle station. `https://` is accepted and converted to `wss://`.
Set `GEMINI_LIVE_AUTH_MODE` to `query`, `bearer`, or `x-goog-api-key` according
to its documentation. A normal OpenAI-compatible HTTP `/v1` base URL cannot be
used for Gemini Live, because it does not implement Gemini's bidirectional
WebSocket protocol. The browser still connects only to this project's local
relay, so the API key never reaches browser code.

## Qwen-Omni Realtime Voice Agent

The browser microphone connects to the local backend relay. The Bailian key is
never sent to the browser. Copy `backend/.env.example` to `backend/.env`, then
set the model enabled for your Bailian account:

```dotenv
QWEN_OMNI_REALTIME_ENABLED=true
DASHSCOPE_API_KEY=your_rotated_dashscope_api_key
QWEN_OMNI_REALTIME_MODEL=qwen3.5-omni-flash-realtime
QWEN_OMNI_REALTIME_VOICE=Ethan
```

Use the exact Realtime model ID shown in the Bailian console if it differs.
Restart the backend after changing `.env`, then open `http://localhost:3000`.
The relay endpoint is `/api/qwen-omni-realtime/relay`; the browser cannot
connect directly to Bailian.

## GPT-5.6 Local Brain

The text Agent can use OpenAI Responses with GPT-5.6 Sol while keeping the
existing browser-side safety and action validation. In `backend/.env`, set:

```dotenv
LOCAL_BRAIN_PROVIDER=openai-responses
LOCAL_BRAIN_MODEL=gpt-5.6-sol
OPENAI_API_KEY=your_openai_api_key
OPENAI_REASONING_EFFORT=none
```

Restart the backend after changing the file. This provider handles typed Agent
messages and approved robot actions. It does not replace Gemini Live's
bidirectional microphone/audio transport.

## Firmware

Firmware source is in `src/main.cpp`. It exposes one BLE service:

- Target: ESP32-S3-WROOM-1-N16R8 (16 MB QIO flash, 8 MB OPI PSRAM)
- TB6612: AIN1 `GPIO4`, AIN2 `GPIO5`, PWMA `GPIO6`, BIN1 `GPIO7`, BIN2 `GPIO8`, PWMB `GPIO9`, STBY `GPIO10`
- Gimbal PWM: yaw `GPIO15`, pitch `GPIO16`
- Reserved: USB `GPIO19/20`, UART0 `GPIO43/44`, strapping `GPIO0/3/45/46`, OPI PSRAM `GPIO35/36/37`

- Service: `7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0001`
- Command characteristic: `7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0002`
- Events characteristic: `7f2c2b6a-2d8f-4f6b-9a59-8a7f9d7c0003`

The browser sends newline-delimited JSON commands in small BLE chunks. Firmware
responds with newline-delimited JSON notifications.

The browser firmware uploader serves four ESP32-S3 images from
`frontend/firmware/`: `bootloader.bin`, `partitions.bin`, `boot_app0.bin`, and
`firmware.bin`. The manifest uses the ESP32-S3 bootloader offset `0x0` and the
16 MB OTA partition layout.

## Mobile Drive Controller

The mobile-first direct controller is available at
`/mobile-controller/` when the frontend is served. It connects directly to
`LOOI-S3` over Web Bluetooth; it does not use the server or an ESP32 Wi-Fi
connection. It uses the current differential-drive firmware protocol:

- `motion` with `left_speed` and `right_speed`
- `head_yaw` with yaw angles from `0` through `180` degrees
- `head_pitch` with pitch angles from `0` through `90` degrees

The page must run on HTTPS for a phone browser. Use current Chrome or Edge on
Android and open the deployed site directly, rather than inside an in-app
browser. iPhone and iPad browsers do not expose Web Bluetooth; direct BLE from
a website is therefore unavailable on iOS and requires a native application.

## Gimbal Control

The gimbal starts in `curious_idle`, which makes small yaw-only scans. The pitch
servo remains still during idle behavior and visual observations. Pitch and
explicit yaw movement require a direct user command from the Manual Console;
Agent physical movement is rejected while Manual mode is active.

The restricted `set_gimbal_mode` action accepts only `curious_idle` and `off`.
It never accepts GPIO, PWM, motor, or raw WebSocket fields. To add a future
voice remote, register a browser-owned handler with
`ToolExecutor.registerVoiceCommand(type, handler)`, then add the same type to
the Gemini declaration and both local-brain validators. Keep the handler at the
high-level action boundary; do not expose raw hardware commands to the model.

## Checks

```sh
cd backend
npm run smoke:gemini-live
npm run smoke:tools
npm run smoke:esp32
npm run smoke:manual-controls
```

`npm run smoke:all` runs the broader non-PlatformIO smoke suite.

## Safety

Firmware clamps speed, command duration, ramp, PWM, and head-pitch limits. It
auto-stops when motion expires, when invalid JSON arrives, and when Bluetooth
disconnects. Lift the wheels for first tests.
