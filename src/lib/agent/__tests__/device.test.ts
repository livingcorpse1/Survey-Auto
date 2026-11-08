import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLUESTACKS_ADDRESS,
  deviceRecoveryReason,
  inspectDeviceStatus,
  isDeviceOnline,
  parseAdbDevicesOutput,
  reconnectTarget,
} from '@/lib/agent/device';

const DEVICES_OUTPUT = `List of devices attached
* daemon not running; starting now at tcp:5037
* daemon started successfully
adb server version (41) doesn't match this client (39)
127.0.0.1:5555\tdevice product:BlueStacks model:BST instance:1
emulator-5554\toffline
ZY22ABCDEF\tunauthorized
`;

describe('adb device helpers', () => {
  it('parses real device rows and ignores daemon noise', () => {
    expect(parseAdbDevicesOutput(DEVICES_OUTPUT)).toEqual([
      { serial: '127.0.0.1:5555', state: 'device' },
      { serial: 'emulator-5554', state: 'offline' },
      { serial: 'ZY22ABCDEF', state: 'unauthorized' },
    ]);
  });

  it('treats only the device state as online', () => {
    expect(isDeviceOnline('device')).toBe(true);
    expect(isDeviceOnline(' DEVICE ')).toBe(true);
    expect(isDeviceOnline('offline')).toBe(false);
    expect(isDeviceOnline('unauthorized')).toBe(false);
  });

  it('reports no recovery when at least one device is online', () => {
    const devices = parseAdbDevicesOutput(DEVICES_OUTPUT);
    expect(deviceRecoveryReason(devices)).toBeNull();
    expect(deviceRecoveryReason(devices, '127.0.0.1:5555')).toBeNull();
  });

  it('classifies missing, offline and unauthorized targets', () => {
    const devices = parseAdbDevicesOutput('127.0.0.1:5555 device\nemulator-5554 offline\nABC unauthorized\n');
    expect(deviceRecoveryReason(devices, 'nope')).toBe('missing');
    expect(deviceRecoveryReason(devices, 'emulator-5554')).toBe('offline');
    expect(deviceRecoveryReason(devices, 'ABC')).toBe('unauthorized');
  });

  it('reports no-online-device when every row is offline', () => {
    expect(deviceRecoveryReason(parseAdbDevicesOutput('emulator-5554 offline\n'))).toBe('no-online-device');
    expect(deviceRecoveryReason([], 'emulator-5554')).toBe('missing');
  });

  it('offers a reconnect target only for addressable, non-unauthorized devices', () => {
    expect(reconnectTarget('missing')).toBe(DEFAULT_BLUESTACKS_ADDRESS);
    expect(reconnectTarget('missing', '')).toBe(DEFAULT_BLUESTACKS_ADDRESS);
    expect(reconnectTarget('missing', DEFAULT_BLUESTACKS_ADDRESS)).toBe(DEFAULT_BLUESTACKS_ADDRESS);
    expect(reconnectTarget('offline', '127.0.0.1:5555')).toBe('127.0.0.1:5555');
    expect(reconnectTarget('offline', 'emulator-5554')).toBeNull();
    expect(reconnectTarget('unauthorized', '127.0.0.1:5555')).toBeNull();
    expect(reconnectTarget(null)).toBeNull();
  });

  it('combines parsing, reason and reconnect target', () => {
    expect(inspectDeviceStatus('127.0.0.1:5555 offline\n', '127.0.0.1:5555')).toEqual({
      devices: [{ serial: '127.0.0.1:5555', state: 'offline' }],
      serial: '127.0.0.1:5555',
      recoveryReason: 'offline',
      reconnectTarget: '127.0.0.1:5555',
    });
  });
});
