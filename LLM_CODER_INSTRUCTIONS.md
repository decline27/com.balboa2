# LLM Coder Handoff: BWA Local Implementation

This document provides necessary technical context for an AI coder to maintain or extend the BWA local control implementation in this Homey app.

## Protocol Architecture (Local TCP)

The BWA device communicates locally via TCP on port **4257**.
- **Framing**: `7E [LEN] [PAYLOAD] [CRC] 7E`
- **UDP Discovery**: Port **30303** (often unreliable in Docker/vLANs).
- **Control Interface**: `lib/balboa/local.js` (TCP Client).
- **Device Driver**: `drivers/BWA/device.js` (Homey Logic).

## Key Discoveries & Logic

### 1. Status Packet Offsets (0xFF 0xAF 0x13)
The indices in the local status update differ from the cloud protocol. Counting from index 0 at the `0xFF` byte:
- **Target Temperature**: `data[9]` (direct Celsius value, NOT doubled)
- **Actual Temperature**: `data[10]` (doubled Celsius value, divide by 2)
- **Flags (Scale/Mode/Range)**: `data[12]`
  - `data[12] & 0x01`: 0 = Fahrenheit, 1 = Celsius.
  - `(data[12] >> 1) & 0x03`: 0 = READY, 1 = REST, 2/3 = READY_REST.
  - `data[12] & 0x04`: 0 = LOW Range, 4 = HIGH Range.
- **Pumps Status**: `data[13]` (Bit-mapped, 2 bits per pump).

### 2. Command Precise Payloads
- **Temperature (Celsius)**: 
  - **Sending Commands**: Send `value * 2` to support 0.5°C steps (e.g., Payload `74` for `37.0°C`).
  - **Receiving Status**: Values are already human-readable (e.g., Raw `37` = `37°C`). **Asymmetric protocol!**
- **Temperature (Fahrenheit)**: Send/receive raw values directly.
- **Toggle Commands**: Sent via `0x11` (Blower: `0x0C`, Light: `0x11`, Pumps: `0x04 + port`).

### 3. State Management (Command Locking)
Spas have high latency. Status packets broadcast the *old* state for several seconds after a command is sent.
- **The "Jump-back" Fix**: Implementation of `this._locks` in `device.js`. 
- **Behavior**: When a command is sent, the capability is "locked" for 10 seconds. All incoming status updates for that capability are ignored unless they match the *new* expected value.
- **Verification**: Logs show `Ignoring revert for [capability]` when the lock is active.

## Maintaining the App

### Build System (Docker Permission issues)
There is a recurring permission issue in `.homeybuild`.
- **Symptoms**: `EACCES: permission denied, rmdir ...`
- **Fix**: Run `chmod -R 777 .homeybuild && rm -rf .homeybuild` before running `homey app run`.

### Scaling
- **Balboa (ControlMySpa) Driver**: Shared logic should be moved to `local.js` if more models are found to use this specific offset layout.
- **Capability Discovery**: Added `Manual IP` fallback in pairing to bypass UDP discovery failure.

## Files to Review
- `lib/balboa/local.js`: Core parser and TCP handling.
- `drivers/BWA/device.js`: Capability listeners and command lock logic.
- `drivers/BWA/driver.js`: Local/Cloud mode switching.
