const net = require('net');
const EventEmitter = require('events');

/**
 * BalboaLocal - Minimal local implementation for Balboa (BWA)
 * Communication on port 4257 (TCP)
 */
class BalboaLocal extends EventEmitter {
    constructor(host) {
        super();
        this.host = host;
        this.port = 4257;
        this.client = null;
        this.lastState = null;
        this.lastConfig = null;
        this.reconnectTimeout = null;
        this.connected = false;

        // Connect-on-demand for energy saving
        this.pollIntervalMs = 60000; // 1 minute between polls
        this.pollTimeout = null;
        this.disconnectTimeout = null;
        this.pendingCommand = false; // If we're waiting for command confirmation
        this.disconnectDelayMs = 3000; // Disconnect 3 seconds after last status
    }

    async connect() {
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);

        console.log(`[BalboaLocal] Connecting to ${this.host}:${this.port}...`);

        this.client = new net.Socket();

        this.client.connect(this.port, this.host, () => {
            console.log(`[BalboaLocal] Connected to ${this.host}`);
            this.connected = true;
            this.emit('connected');
            // Request configuration
            this.sendConfigCommand();
        });

        this.client.on('data', (data) => {
            this._handleData(data);
        });

        this.client.on('error', (err) => {
            console.error(`[BalboaLocal] Socket Error: ${err.message}`);
            this._scheduleNextPoll();
        });

        this.client.on('close', () => {
            console.log(`[BalboaLocal] Connection closed`);
            this.connected = false;
            // Don't auto-reconnect - we'll connect on next poll or command
        });
    }

    /**
     * Disconnect from spa (for energy saving)
     * No automatic reconnect - will reconnect only when command is sent
     */
    disconnect() {
        if (this.disconnectTimeout) {
            clearTimeout(this.disconnectTimeout);
            this.disconnectTimeout = null; // Reset so we can schedule again on next connect
        }
        if (this.pollTimeout) clearTimeout(this.pollTimeout);
        if (this.client) {
            console.log(`[BalboaLocal] Disconnecting for energy saving (no auto-reconnect)...`);
            // Gracefully close the socket (sends FIN) so spa releases the connection slot
            this.client.end();
            // Then destroy to ensure cleanup
            setTimeout(() => {
                if (this.client) {
                    this.client.destroy();
                    this.client = null;
                }
            }, 500);
            this.connected = false;
        }
        // No auto-reconnect! Will only connect when command is sent
    }

    /**
     * Schedule disconnect after receiving status (for energy saving)
     * Only schedules once - doesn't reset on subsequent status messages
     */
    _scheduleDisconnect() {
        // Don't disconnect if we have a pending command
        if (this.pendingCommand) return;

        // Only schedule once - don't reset timer on each status
        if (this.disconnectTimeout) return;

        console.log(`[BalboaLocal] Scheduling disconnect in ${this.disconnectDelayMs}ms...`);
        this.disconnectTimeout = setTimeout(() => {
            this.disconnect();
        }, this.disconnectDelayMs);
    }

    /**
     * Schedule next poll connection (disabled for energy saving)
     * Kept for backwards compatibility but does nothing
     */
    _scheduleNextPoll() {
        // Disabled - connect-on-demand only
        console.log(`[BalboaLocal] Polling disabled - will connect on next command`);
    }

    _reconnect() {
        // Disabled - connect-on-demand only
    }

    _handleData(data) {
        // Balboa messages are framed: 7E LEN PAYLOAD CRC 7E
        // We might get multiple messages in one data chunk
        let offset = 0;
        while (offset < data.length) {
            if (data[offset] === 0x7E) {
                const len = data[offset + 1];
                if (offset + len + 2 <= data.length) {
                    const message = data.slice(offset, offset + len + 2);
                    this._processMessage(message);
                    offset += len + 2;
                    continue;
                }
            }
            offset++;
        }
    }

    _processMessage(message) {
        const type = message[2];
        const payload = message.slice(3, message.length - 2);

        // Type 0xFF 0xAF 0x13 is typical status update
        if (message[2] === 0xff && message[3] === 0xaf && message[4] === 0x13) {
            // Slicing from index 2 (the FF byte) so indices match my analysis (FF=0)
            const data = message.slice(2, message.length - 2);
            this.lastState = this._parseStatus(data);
            this.emit('status', this.lastState);
            // Schedule disconnect for energy saving
            this._scheduleDisconnect();
        } else if (message[2] === 0x0a && message[3] === 0xbf && message[4] === 0x94) {
            // Configuration Response: 0x0a 0xbf 0x94
            const configPayload = message.slice(5, message.length - 2);
            this.lastConfig = this._parseConfig(configPayload);
            this.emit('config', this.lastConfig);
            // Schedule disconnect for energy saving
            this._scheduleDisconnect();
        }
    }

    _parseConfig(data) {
        // Balboa Configuration Information Message (0x0a)
        return {
            pumps: {
                Pump1: (data[4] & 0x03) !== 0,
                Pump2: (data[4] & 0x0c) !== 0,
                // Pump3-6 disabled: config bits don't reliably indicate controllable pumps
                Pump3: false,
                Pump4: false,
                Pump5: false,
                Pump6: false
            },
            lights: {
                Light1: (data[6] & 0x03) !== 0,
                Light2: (data[6] & 0x0c) !== 0
            },
            blower: (data[7] & 0x0c) !== 0,
            aux: {
                Aux1: (data[8] & 0x01) !== 0,
                Aux2: (data[8] & 0x02) !== 0
            },
            mister: (data[8] & 0x10) !== 0
        };
    }

    _parseStatus(data) {
        // Definitive offsets from local protocol documentation (mapping to ours where data[0] is 0xFF):
        // CT: 5, HH: 6, MM: 7, F2: 8, F3: 12, F4: 13, PP: 14, LF: 17, ST: 23

        const currentTimeHour = data[6];
        const currentTimeMinute = data[7];
        const temperatureScale = (data[12] & 0x01) === 0 ? 'F' : 'C';
        const temperatureRange = (data[13] & 0x04) === 0x04 ? 'HIGH' : 'LOW';
        const isHeating = (data[13] & 0x30) !== 0;

        // Both temperatures are doubled in Celsius mod per local docs
        let actualTemperature = data[5];
        let targetTemperature = data[23];

        if (temperatureScale === 'C') {
            actualTemperature = actualTemperature / 2;
            targetTemperature = targetTemperature / 2;
        }

        let heaterMode;
        // Flags 2 (index 8) contains Heating Mode at bits 0x03
        const modeBits = data[8] & 0x03;
        switch (modeBits) {
            case 0: heaterMode = 'READY'; break;
            case 1: heaterMode = 'REST'; break;
            case 3: heaterMode = 'READY_REST'; break;
            default: heaterMode = 'READY';
        }

        const components = [];

        // Pumps (Index 14) - 2 bits per pump: 0=OFF, 1=LOW, 2=HIGH
        for (let i = 0; i < 4; i++) {
            let pumpState = 'OFF';
            const val = (data[14] >> (i * 2)) & 0x03;
            if (val === 1) pumpState = 'LOW';
            else if (val === 2) pumpState = 'HIGH';
            components.push({ componentType: 'PUMP', port: i.toString(), value: pumpState });
        }

        // Blower - at byte 18 in the raw message (data[16] with our offset)
        // Bits 2-3: 0=OFF, 1=LOW, 2=MEDIUM, 3=HIGH
        let blowerState = 'OFF';
        const blowerByte = data[16] || 0;
        const blowerVal = (blowerByte >> 2) & 0x03;
        if (blowerVal === 1) blowerState = 'LOW';
        else if (blowerVal === 2) blowerState = 'MEDIUM';
        else if (blowerVal === 3) blowerState = 'HIGH';
        components.push({ componentType: 'BLOWER', port: '0', value: blowerState });

        // Lights (Index 17) - bit 0x03
        const light1 = (data[17] & 0x03) !== 0 ? 'HIGH' : 'OFF';
        components.push({ componentType: 'LIGHT', port: '0', value: light1 });

        // Heater
        components.push({ componentType: 'HEATER', value: isHeating ? 'ON' : 'OFF' });

        return {
            desiredTemp: targetTemperature,
            targetDesiredTemp: targetTemperature,
            currentTemp: actualTemperature,
            panelLock: (data[11] & 0x10) !== 0,
            heaterMode: heaterMode,
            components: components,
            online: true,
            tempRange: temperatureRange,
            setupParams: {
                highRangeLow: 10,
                highRangeHigh: 40,
                lowRangeLow: 10,
                lowRangeHigh: 30
            },
            hour: currentTimeHour,
            minute: currentTimeMinute,
            military: true,
            temperatureScale: temperatureScale
        };
    }

    async setJetState(port, state) {
        if (!this.lastState) return;
        const pump = this.lastState.components.find(c => c.componentType === 'PUMP' && c.port === port.toString());
        if (!pump) return;

        const isCurrentlyOn = pump.value !== 'OFF';
        const targetOn = !!state;

        if (isCurrentlyOn !== targetOn) {
            console.log(`[BalboaLocal] Toggling Pump ${parseInt(port) + 1} to ${targetOn ? 'ON' : 'OFF'}`);
            const pumpCode = 0x04 + parseInt(port);
            this.sendCommand(0x11, [pumpCode, 0x00]);
        }
        return this.lastState;
    }

    async setLightState(port, state) {
        if (!this.lastState) return;
        const light = this.lastState.components.find(c => c.componentType === 'LIGHT' && c.port === port.toString());
        if (!light) return;

        const isCurrentlyOn = light.value !== 'OFF';
        const targetOn = !!state;

        if (isCurrentlyOn !== targetOn) {
            console.log(`[BalboaLocal] Toggling Light ${parseInt(port) + 1} to ${targetOn ? 'ON' : 'OFF'}`);
            this.sendCommand(0x11, [0x11, 0x00]);
        }
        return this.lastState;
    }

    async setBlowerState(port, state) {
        if (!this.lastState) return;
        const blower = this.lastState.components.find(c => c.componentType === 'BLOWER');
        if (!blower) return;

        const isCurrentlyOn = blower.value !== 'OFF';
        const targetOn = !!state;

        if (isCurrentlyOn !== targetOn) {
            console.log(`[BalboaLocal] Toggling Blower to ${targetOn ? 'ON' : 'OFF'}`);
            this.sendCommand(0x11, [0x0c, 0x00]);
        }
        return this.lastState;
    }

    async setTemp(tempCelsius) {
        if (!this.lastState) return;

        const temperatureScale = this.lastState.temperatureScale || 'F';
        let val;
        let displayTemp;

        if (temperatureScale === 'C') {
            // Balboa expects temp * 2 for Celsius commands
            val = Math.round(tempCelsius * 2);
            displayTemp = `${tempCelsius}°C`;
        } else {
            // Convert C to F
            val = Math.round((tempCelsius * 9 / 5) + 32);
            displayTemp = `${val}°F`;
        }

        console.log(`[BalboaLocal] Setting temperature to ${displayTemp} (Payload: ${val})`);
        this.sendCommand(0x20, [val]); // Command 0x20: Set Temperature
        return this.lastState;
    }

    async setHeaterMode(mode) {
        if (!this.lastState) return;
        // mode is 'READY' or 'REST'
        const currentMode = this.lastState.heaterMode;
        if (currentMode !== mode) {
            console.log(`[BalboaLocal] Toggling Heater Mode to ${mode}`);
            this.sendCommand(0x11, [0x51, 0x00]); // Command 0x11 + 0x51: Toggle Heat Mode
        }
        return this.lastState;
    }

    async setTempRange(range) {
        if (!this.lastState) return;
        // range is 'HIGH' or 'LOW'
        const currentRange = this.lastState.tempRange;
        if (currentRange !== range) {
            console.log(`[BalboaLocal] Toggling Temperature Range to ${range}`);
            this.sendCommand(0x11, [0x50, 0x00]); // Command 0x11 + 0x50: Toggle Temp Range
        }
        return this.lastState;
    }

    sendConfigCommand() {
        // Request configuration information (Configuration Request: 0x0A 0xBF 0x04)
        // This returns message type 0x0A 0xBF 0x94 with pump/blower presence info
        this.sendCommand(0x04, []);
    }

    /**
     * Ensure connected before sending command
     */
    async ensureConnected() {
        if (this.connected && this.client) return Promise.resolve();

        // Cancel any scheduled disconnect or poll
        if (this.disconnectTimeout) clearTimeout(this.disconnectTimeout);
        if (this.pollTimeout) clearTimeout(this.pollTimeout);

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Connection timeout'));
            }, 10000);

            this.once('connected', () => {
                clearTimeout(timeout);
                resolve();
            });

            this.connect();
        });
    }

    async sendCommand(type, payload = []) {
        // Set pending command to prevent disconnect during command sequence
        this.pendingCommand = true;
        if (this.disconnectTimeout) clearTimeout(this.disconnectTimeout);

        // Ensure we're connected
        if (!this.client || !this.connected) {
            try {
                await this.ensureConnected();
            } catch (err) {
                console.error(`[BalboaLocal] Failed to connect for command: ${err.message}`);
                this.pendingCommand = false;
                return;
            }
        }

        const payloadBuffer = Buffer.from(payload);
        // Balboa commands are: 7E LEN 0A BF [TYPE] [PAYLOAD...] [CRC] 7E
        // LEN = 1(LEN) + 1(0A) + 1(BF) + 1(TYPE) + PAYLOAD_LEN + 1(CRC)
        const len = payloadBuffer.length + 5;
        const message = Buffer.alloc(len + 2); // 7E + (LEN...CRC) + 7E

        message[0] = 0x7E;
        message[1] = len;
        message[2] = 0x0A;
        message[3] = 0xBF;
        message[4] = type;
        payloadBuffer.copy(message, 5);

        // Calculate CRC on everything from LEN index to last payload byte
        message[len] = this._calculateCRC(message.slice(1, len));
        message[len + 1] = 0x7E;

        this.client.write(message);

        // Allow disconnect after command confirmation (next status update)
        setTimeout(() => {
            this.pendingCommand = false;
        }, 2000);
    }

    _calculateCRC(data) {
        // Balboa CRC-8 with Initial 0x02 and Final XOR 0x02 per official protocol
        let crc = 0x02;
        for (let i = 0; i < data.length; i++) {
            crc = this._crcTable[crc ^ data[i]];
        }
        return crc ^ 0x02;
    }

    // Standard Balboa CRC table
    get _crcTable() {
        return [
            0x00, 0x07, 0x0e, 0x09, 0x1c, 0x1b, 0x12, 0x15, 0x38, 0x3f, 0x36, 0x31, 0x24, 0x23, 0x2a, 0x2d,
            0x70, 0x77, 0x7e, 0x79, 0x6c, 0x6b, 0x62, 0x65, 0x48, 0x4f, 0x46, 0x41, 0x54, 0x53, 0x5a, 0x5d,
            0xe0, 0xe7, 0xee, 0xe9, 0xfc, 0xfb, 0xf2, 0xf5, 0xd8, 0xdf, 0xd6, 0xd1, 0xc4, 0xc3, 0xca, 0xcd,
            0x90, 0x97, 0x9e, 0x99, 0x8c, 0x8b, 0x82, 0x85, 0xa8, 0xaf, 0xa6, 0xa1, 0xb4, 0xb3, 0xba, 0xbd,
            0xc7, 0xc0, 0xc9, 0xce, 0xdb, 0xdc, 0xd5, 0xd2, 0xff, 0xf8, 0xf1, 0xf6, 0xe3, 0xe4, 0xed, 0xea,
            0xb7, 0xb0, 0xb9, 0xbe, 0xab, 0xac, 0xa5, 0xa2, 0x8f, 0x88, 0x81, 0x86, 0x93, 0x94, 0x9d, 0x9a,
            0x27, 0x20, 0x29, 0x2e, 0x3b, 0x3c, 0x35, 0x32, 0x1f, 0x18, 0x11, 0x16, 0x03, 0x04, 0x0d, 0x0a,
            0x57, 0x50, 0x59, 0x5e, 0x4b, 0x4c, 0x45, 0x42, 0x6f, 0x68, 0x61, 0x66, 0x73, 0x74, 0x7d, 0x7a,
            0x89, 0x8e, 0x87, 0x80, 0x95, 0x92, 0x9b, 0x9c, 0xb1, 0xb6, 0xbf, 0xb8, 0xad, 0xaa, 0xa3, 0xa4,
            0xf9, 0xfe, 0xf7, 0xf0, 0xe5, 0xe2, 0xeb, 0xec, 0xc1, 0xc6, 0xcf, 0xc8, 0xdd, 0xda, 0xd3, 0xd4,
            0x69, 0x6e, 0x67, 0x60, 0x75, 0x72, 0x7b, 0x7c, 0x51, 0x56, 0x5f, 0x58, 0x4d, 0x4a, 0x43, 0x44,
            0x19, 0x1e, 0x17, 0x10, 0x05, 0x02, 0x0b, 0x0c, 0x21, 0x26, 0x2f, 0x28, 0x3d, 0x3a, 0x33, 0x34,
            0x4e, 0x49, 0x40, 0x47, 0x52, 0x55, 0x5c, 0x5b, 0x76, 0x71, 0x78, 0x7f, 0x6a, 0x6d, 0x64, 0x63,
            0x3e, 0x39, 0x30, 0x37, 0x22, 0x25, 0x2c, 0x2b, 0x06, 0x01, 0x08, 0x0f, 0x1a, 0x1d, 0x14, 0x13,
            0xae, 0xa9, 0xa0, 0xa7, 0xb2, 0xb5, 0xbc, 0xbb, 0x96, 0x91, 0x98, 0x9f, 0x8a, 0x8d, 0x84, 0x83,
            0xde, 0xd9, 0xd0, 0xd7, 0xc2, 0xc5, 0xcc, 0xcb, 0xe6, 0xe1, 0xe8, 0xef, 0xfa, 0xfd, 0xf4, 0xf3
        ];
    }

    /**
     * Static method to discover Balboa spas on the local network
     * Scans common local subnets for devices listening on port 4257
     * @param {number} timeout - Discovery timeout in ms
     * @returns {Promise<string[]>} - Array of discovered IP addresses
     */
    static async discover(timeout = 5000) {
        const foundIps = [];
        const scanPromises = [];

        // Get local network interfaces to determine subnet
        const os = require('os');
        const interfaces = os.networkInterfaces();

        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                if (iface.family === 'IPv4' && !iface.internal) {
                    // Extract subnet (e.g., 192.168.1 from 192.168.1.100)
                    const parts = iface.address.split('.');
                    const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;

                    console.log(`[BalboaLocal] Scanning subnet ${subnet}.x for Balboa spas...`);

                    // Scan all IPs in subnet
                    for (let i = 1; i <= 254; i++) {
                        const ip = `${subnet}.${i}`;
                        scanPromises.push(
                            BalboaLocal._checkHost(ip, 4257, Math.min(timeout, 2000))
                                .then(reachable => {
                                    if (reachable) {
                                        console.log(`[BalboaLocal] Found spa at ${ip}`);
                                        foundIps.push(ip);
                                    }
                                })
                                .catch(() => { })
                        );
                    }
                }
            }
        }

        // Wait for all scans to complete or timeout
        await Promise.race([
            Promise.all(scanPromises),
            new Promise(resolve => setTimeout(resolve, timeout))
        ]);

        return foundIps;
    }

    /**
     * Check if a host is reachable on a specific port
     */
    static _checkHost(host, port, timeout) {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            let resolved = false;

            socket.setTimeout(timeout);

            socket.on('connect', () => {
                resolved = true;
                socket.destroy();
                resolve(true);
            });

            socket.on('timeout', () => {
                if (!resolved) {
                    socket.destroy();
                    resolve(false);
                }
            });

            socket.on('error', () => {
                if (!resolved) {
                    socket.destroy();
                    resolve(false);
                }
            });

            socket.connect(port, host);
        });
    }
}

module.exports = BalboaLocal;
