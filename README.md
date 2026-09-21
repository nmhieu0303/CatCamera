# Imou dual-camera Web PoC (React + TypeScript)

A local-only starter using the official **ImouPlayer Web SDK** + Fastify backend. It displays two camera panels; it does **not** include the proprietary Imou binaries, actual credentials, AI detection or internet-facing authentication. **Video playback has NOT been validated with your devices.**

## Official references
- SDK usage: https://open.imoulife.com/book/js/sdk.html
- SDK download: https://open.imoulife.com/book/readme/upload.html (Web Video SDK&Demo for Light App)
- API authentication / region: https://open.imoulife.com/book/http/develop.html
- accessToken: https://open.imoulife.com/book/http/accessToken.html

## Prerequisites
Node.js 22+ recommended; Imou Open Platform developer app with AppId/AppSecret; both cameras visible/authorized in that developer context. A camera registered only in Imou Life does **not** automatically establish developer API access. Device IDs from the user's initial message were NOT included in the source: confirm if those are serial numbers.

## Setup
1. The repository currently contains the vendor `imou-player.js` 1.3.8, CSS, and complete `WasmLib`/worker assets under `public/imou-sdk/`. If you replace them, download **Web Video SDK&Demo for Light App** from the official resource page and preserve the vendor layout; update `WasmLibPath` in `src/main.tsx` if the layout changes.
2. `cp .env.example .env`. Set `IMOU_APP_ID`, `IMOU_APP_SECRET`, correct `IMOU_REGION` (sg/fk/or based on developer console), and both camera serials. Keep `.env` private. Check channel IDs (usually 0 for IPC).
3. `npm install`
4. `npm run dev`
5. Open `http://127.0.0.1:5173`. Click Connect on each camera with the encryption field blank first. The documented default is HD; use SD if the machine cannot decode two streams. If the SDK reports code 1001, enter that camera's configured device password or custom encryption key and reconnect (the browser passes it to the SDK only; the app does not persist it).

The browser SDK uses the configured `IMOU_REGION` to proxy its documented `getBuryConfig`, `getDeviceEncryptKey`, `getEncryptKitStreamUrl`, and telemetry requests. `sg` is the East Asia data center endpoint; use `fk` or `or` only when the developer console assigns the account to those data centers. Set `VITE_DEBUG_IMOU=true` only for local troubleshooting; application debug output contains status, timing, camera slot, and redacted SDK error fields, never keys or tokens.

The **Chẩn đoán thiết bị** button calls the backend-only `listDeviceDetailsByIds` diagnostic for a configured camera slot. It returns only model, online status, capability strings, channel status, and the documented encryption mode; it never returns the serial number, device password, access token, kitToken, or vendor response. The official API describes `encryptMode=0` as device-default encryption and `encryptMode=1` as user-defined encryption. For this SDK version, an empty `code` follows the official demo's default path; do not force the serial number into the field when the camera has no configured password or custom key.

## Pull request checks

`.github/workflows/pr-review.yml` runs the TypeScript check, backend syntax check, Imou SDK asset checks, optional lint/tests, and the production build. It updates one status comment on same-repository pull requests. To receive the same result in Microsoft Teams, add an Actions secret named `TEAMS_WEBHOOK_URL`; the workflow skips the notification when the secret is not configured.

## Authentication and security
Backend creates the **current documented** signature SHA256(secret) -> HMAC-SHA256 -> Base64 and calls `accessToken`, then `getKitToken` with permission type `1` (live-view only). It caches admin tokens and each kit token, returns only a short-lived kit token to the frontend, never AppSecret. The backend only serves two configured camera slots and binds to loopback. This sample has **no user auth**; never deploy publicly. KitToken is still a sensitive credential and must not be logged or stored. If making a public app, add HTTPS, user authentication and per-device authorization, CSRF/origin controls, token-rate limits and audit logs.

## Troubleshooting
- API 502: credentials, datacenter, account authorization / device binding, system clock, Imou quota, token permissions. Check server logs; SDK/browser errors are displayed per camera.
- Empty area / 404 for WASM: verify `public/imou-sdk/` layout and `WasmLibPath`; check Network tab. The example uses `/imou-sdk/`, so adapt it to the downloaded SDK structure.
- Player 1001: decryption key is wrong; see official SDK code guidance. **Do not send camera keys to anyone.**
- Black image: camera unsupported/offline, missing developer permissions, vendor quotas, network, SDK version, stream choice, encryption or third-party resource blocking from COEP.
- COEP/COOP: Vite enables official recommended headers for multithreading. If vendor assets are blocked, inspect developer console and vendor demo; don't bypass browser security to fix a production integration.
- Running 2 players can be CPU-intensive per official FAQ. Try SD first.
- This SDK is a browser preview SDK, **not proof** that a backend AI worker can obtain raw video frames. Verify HLS/RTSP or official permitted server-side stream separately for AI.

## Not supported / unverified
The SDK integration and Camera 1 kit-token path were exercised locally, but simultaneous video from both real cameras is not verified. The current Camera 1 attempt reached the SDK and returned code 1001, which requires the correct device encryption key or device-side configuration. Do not automatically unbind/reset devices to fix account association.
