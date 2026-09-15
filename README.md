# Homebridge MCP

Created by Freddy Reyes ([https://freddyreyes.com](https://freddyreyes.com)).

`homebridge-mcp` is a self-contained Homebridge plugin that exposes Homebridge accessories through an authenticated MCP HTTP endpoint. It runs inside the Homebridge process and requires no companion service, database, or separate runtime.

It can be used with ChatGPT and Claude through MCP-compatible connections.

## Features

- Read-only discovery from Homebridge accessory cache files.
- Live read refresh through configured local Homebridge HAP endpoints.
- Normalized device, room, state, and capability data.
- Explicit controls for power, brightness, and thermostat targets.
- Camera snapshots returned as image attachments.
- Bearer-token authentication, optional Cloudflare Access validation, and audit logging.
- Deny-by-default per-device write allowlisting.

## Installation

Install `homebridge-mcp` through Homebridge Config UI X, or run:

```bash
sudo npm install -g homebridge-mcp
```

Restart Homebridge after installation when the environment does not restart it automatically.

## Configuration

Configure the plugin through the normal Homebridge UI. The important settings are:

- `enabled`, `bind`, `port`, and `path` control the listener. The defaults are `127.0.0.1`, `8765`, and `/mcp`.
- `token` is the bearer token. Use a generated value of at least 16 characters and never publish it.
- `readOnly` disables all write tools.
- `writableDeviceIds` is a comma- or newline-separated allowlist. Only listed live devices can be written.
- `permissions` controls category-level access. Locks, garage doors, and security systems default to disabled.
- `cameraPin` is an optional setup PIN for external Homebridge camera bridges and is never logged.
- `cloudflareAccess` optionally validates the signed assertion supplied by an HTTPS reverse proxy.

Example configuration:

```json
{
  "platform": "HomebridgeMCP",
  "name": "Homebridge MCP",
  "enabled": true,
  "bind": "127.0.0.1",
  "port": 8765,
  "path": "/mcp",
  "token": "replace-with-a-long-random-token",
  "readOnly": false,
  "writableDeviceIds": "homebridge-live-8765-2"
}
```

## Endpoint access

Send JSON-RPC requests to `http://127.0.0.1:8765/mcp` with:

```http
Authorization: Bearer <token>
Content-Type: application/json
```

The listener accepts `POST` requests only. Keep the bind address on localhost unless an external HTTPS proxy is configured deliberately.

For remote access, place an existing HTTPS reverse proxy or Cloudflare Tunnel in front of the local endpoint:

```text
https://home-mcp.example.com/mcp
            |
       HTTPS proxy
            |
  127.0.0.1:8765/mcp
```

Keep Homebridge itself private and configure the proxy to forward only the MCP path. Cloudflare Access validation is enabled with `teamDomain` and `audience` in the plugin configuration.

## MCP methods and tools

The server supports `initialize`, `server/discover`, `tools/list`, and `tools/call`.

Available tools are:

- `home_list_devices`
- `home_get_device`
- `home_get_camera_snapshot`
- `home_turn_on`
- `home_turn_off`
- `home_set_brightness`
- `home_set_temperature`

All tool schemas use an object input schema. Write tools are omitted when `readOnly` is enabled. Ambiguous names are rejected; use a stable device ID or include the room-qualified name.

## Discovery and device model

The live adapter reads configured Homebridge bridge ports through the local HAP `/accessories` endpoint. It is read-only for discovery and refreshes current values when possible. If live discovery is unavailable, the plugin falls back to persisted accessory cache files, which are snapshots and cannot be used for writes.

Services sharing one HomeKit accessory ID are merged into one physical device record. Battery, health, motion, and similar services are represented as capabilities rather than separate devices.

Supported normalized capabilities include power, on/off, brightness, current and target temperature, heating/cooling state, fan speed, contact, motion, occupancy, battery level, and camera snapshots when available.

## Security model

- The listener is localhost-only by default.
- Every request requires the configured bearer token or a valid Cloudflare Access assertion.
- Writes require `readOnly: false`, the matching category permission, and an explicitly allowlisted live device ID.
- Cache-only devices remain read-only.
- Locks, garage doors, and security systems are disabled by default.
- Raw characteristic writes and arbitrary Homebridge API passthrough are not exposed.
- Write actions are recorded in Homebridge logs when audit logging is enabled. Tokens and authorization headers are never logged.

## Development

```bash
npm install
npm run build
npm test
npm run lint
```

Tests use mocked Homebridge and HAP responses; real devices are not required.

## Known limitations

- Live discovery requires Homebridge insecure mode and configured local bridge ports.
- The cache fallback is not proof of current reachability.
- Scenes are permissioned in configuration but are not exposed by the current tool surface.
- Camera snapshots depend on the camera bridge supporting the HomeKit resource request.
- Cloudflare Access is an optional external access-control integration; the plugin does not create tunnels, applications, or policies.

## License

MIT
