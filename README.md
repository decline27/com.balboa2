# Control your Balboa Spa with this app

## Current features

- Get spa status
- Set temperature
- Toggle heater mode
- Lock/unlock panel
- Control Jets, Blowers and Lights
- Synchronize the spa clock with Homey

## Connection Modes

### Local Mode (Recommended)
Connect directly to your spa via TCP on port 4257. No cloud dependency, faster response times.
- Enter spa IP address manually during pairing
- Works without internet connection

### Cloud Mode
Connect via Balboa cloud API. Requires Balboa account credentials.

## Setup (Local Mode)
1. Add device using "BWA" driver
2. Enter spa IP address (e.g., 192.168.110.235)
3. Select "Local (without Balboa Cloud)"
4. Device will appear with pump, blower, light, and temperature controls

This project uses bwajs (<https://github.com/oh2th-homey/com.balboa>), which is licensed under the MIT License.

This project uses controlmyspajs (<https://gitlab.com/VVlasy/controlmyspajs>), which is licensed under the MIT License.
