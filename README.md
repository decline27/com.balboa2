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

## Energy Saving with Electricity Prices

Use Homey flows to heat your spa only when electricity is cheap.

### Required Apps
Install one of these from the Homey App Store:
- **Tibber** - If you have Tibber as your provider
- **Nordpool** - Generic Nordic electricity prices

### Example Flows

**Flow 1: Cheap Power - Enable Heating**
```
WHEN:  [Tibber/Nordpool] Price drops below 0.50 kr/kWh
THEN:  [BWA Spa] Set heater mode ON
```

**Flow 2: Expensive Power - Disable Heating**
```
WHEN:  [Tibber/Nordpool] Price rises above 1.00 kr/kWh
THEN:  [BWA Spa] Set heater mode OFF
```

**Flow 3: Pre-heat Before Use**
```
WHEN:  Time is 2 hours before your typical spa time
AND:   [Tibber/Nordpool] Price is in lowest 3 hours of next 6
THEN:  [BWA Spa] Set heater mode ON
```

### Tips
- **REST mode** keeps minimal heat but stops active heating - great for expensive hours
- Water holds heat well - pre-heat during cheap hours
- Lower target temp by a few degrees instead of disabling completely

This project uses bwajs (<https://github.com/oh2th-homey/com.balboa>), which is licensed under the MIT License.

This project uses controlmyspajs (<https://gitlab.com/VVlasy/controlmyspajs>), which is licensed under the MIT License.
