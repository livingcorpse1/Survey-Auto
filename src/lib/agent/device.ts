export const DEFAULT_BLUESTACKS_ADDRESS = '127.0.0.1:5555';

const ADB_STATES = new Set([
  'device',
  'offline',
  'unauthorized',
  'bootloader',
  'recovery',
  'sideload',
  'host',
  'connecting',
  'authorizing',
  'unknown',
  'no',
  'rescue',
]);

export interface AdbDeviceInfo {
  serial: string;
  state: string;
}

export type DeviceRecoveryReason = 'missing' | 'offline' | 'unauthorized' | 'no-online-device' | null;

export interface DeviceStatus {
  devices: AdbDeviceInfo[];
  serial: string;
  recoveryReason: DeviceRecoveryReason;
  reconnectTarget: string | null;
}

export function parseAdbDevicesOutput(output: string): AdbDeviceInfo[] {
  return output
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('*') && !line.startsWith('List of devices'))
    .flatMap(line => {
      const [serial, state] = line.split(/\s+/);
      if (!serial || !state || !ADB_STATES.has(state.toLowerCase())) return [];
      return [{ serial, state: state.toLowerCase() }];
    });
}

export function isDeviceOnline(state: string): boolean {
  return state.trim().toLowerCase() === 'device';
}

export function deviceRecoveryReason(devices: AdbDeviceInfo[], serial?: string): DeviceRecoveryReason {
  const target = serial?.trim();
  if (target) {
    const device = devices.find(entry => entry.serial === target);
    if (!device) return 'missing';
    if (isDeviceOnline(device.state)) return null;
    return device.state === 'unauthorized' ? 'unauthorized' : 'offline';
  }
  return devices.some(device => isDeviceOnline(device.state)) ? null : 'no-online-device';
}

export function reconnectTarget(
  reason: DeviceRecoveryReason,
  serial?: string,
  address = DEFAULT_BLUESTACKS_ADDRESS,
): string | null {
  const target = address?.trim();
  if (!reason || !target) return null;
  if (reason === 'unauthorized') return null;
  const explicit = serial?.trim();
  if (explicit && explicit !== target) return null;
  return target;
}

export function inspectDeviceStatus(
  output: string,
  serial?: string,
  address = DEFAULT_BLUESTACKS_ADDRESS,
): DeviceStatus {
  const devices = parseAdbDevicesOutput(output);
  const targetSerial = serial?.trim() || '';
  const recoveryReason = deviceRecoveryReason(devices, targetSerial || undefined);
  return {
    devices,
    serial: targetSerial,
    recoveryReason,
    reconnectTarget: reconnectTarget(recoveryReason, targetSerial || undefined, address),
  };
}
