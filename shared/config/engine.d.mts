// Type declarations for shared/config/engine.mjs (editor/typecheck convenience)
export interface SettingsDescriptor {
  key: string
  type: 'string' | 'number' | 'boolean' | 'color' | 'select'
  group: string
  label: string
  labelKey?: string
  description?: string
  applies: 'live' | 'restart'
  default?: unknown
  min?: number
  max?: number
  options?: string[]
}

export interface EffectiveConfig {
  defaults: Record<string, unknown>
  overrides: Record<string, unknown>
  envOverrides: Record<string, unknown>
  effective: Record<string, unknown>
  sources: Record<string, 'config.yml' | 'runtime' | 'env'>
  descriptors: SettingsDescriptor[]
  configPath?: string
  settingsPath?: string
}

export function keyPath(key: string): string[]
export function getPath(obj: unknown, key: string): unknown
export function setPath(obj: Record<string, unknown>, key: string, value: unknown): boolean
export function unsetPath(obj: Record<string, unknown>, key: string): boolean
export function loadDescriptors(): SettingsDescriptor[]
export function loadDescriptorMap(descriptors?: SettingsDescriptor[]): Record<string, SettingsDescriptor>
export function coerceValue(desc: SettingsDescriptor, value: unknown): unknown
export function validateValue(desc: SettingsDescriptor, value: unknown): string[]
export function validateOverrides(overrides: Record<string, unknown>, descriptors?: SettingsDescriptor[]): { ok: boolean, errors: Record<string, string[]> }
export function findUp(startDir: string, filename: string): string | null
export function readSettings(settingsPath: string): Record<string, unknown>
export function saveSettings(overrides: Record<string, unknown>, settingsPath: string, opts?: { version?: number }): { updatedAt: string, overrides: Record<string, unknown> }
export function envOverridesFromEnv(env?: NodeJS.ProcessEnv, descriptors?: SettingsDescriptor[], mode?: string): Record<string, unknown>
export function loadEffective(opts?: { configPath?: string, settingsPath?: string, env?: NodeJS.ProcessEnv, mode?: string }): EffectiveConfig
export function settingsPathFor(root: string): string
