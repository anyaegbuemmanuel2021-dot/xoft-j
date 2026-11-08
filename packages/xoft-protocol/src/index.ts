export type Platform = 'android' | 'ios' | 'windows' | 'linux' | 'macos' | 'web' | 'server';
export type DeviceTrust = 'unverified' | 'trusted';
export type DeviceStatus = 'connected' | 'revoked';
export type CommandStatus = 'pending' | 'dispatched' | 'completed' | 'failed' | 'timed_out';

export type DeviceCapability =
  | 'system' | 'applications' | 'screen' | 'notifications' | 'accessibility'
  | 'files' | 'browser' | 'media' | 'clipboard' | 'camera' | 'microphone' | 'computer_use' | 'social';

export interface DeviceState {
  battery: number | null;
  charging: boolean | null;
  network: string | null;
  activeApplication: string | null;
  locked: boolean | null;
  cpu: number | null;
  memory: number | null;
}

export interface XoftDevice {
  id: string; name: string; platform: Platform; trust: DeviceTrust; status: DeviceStatus;
  capabilities: DeviceCapability[]; state: DeviceState; registeredAt: string; lastActiveAt: string;
}

export interface CommandRequest {
  deviceId: string; capability: DeviceCapability; action: string;
  parameters?: Record<string, unknown>; riskLevel?: 'low' | 'medium' | 'high';
  requestedBy?: string; idempotencyKey?: string;
}

export interface CommandEnvelope extends CommandRequest {
  id: string; status: CommandStatus; createdAt: string;
}

export interface CommandResult {
  commandId: string; success: boolean; result?: unknown; error?: string; completedAt?: string;
}

export interface XoftClientConfig { coreUrl: string; apiKey: string; deviceId?: string; deviceName: string; platform: Platform; }

export const PROTOCOL_VERSION = '1.0';
