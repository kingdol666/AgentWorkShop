// Settings persistence for the desktop shell. Kept Electron-free so the
// read/normalize/write contract can be tested with plain Node.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_SETTINGS, normalizeSettings } from './contract.mjs'

export function loadSettings(file) {
  try {
    return normalizeSettings(JSON.parse(readFileSync(file, 'utf8')))
  }
  catch {
    // A missing or corrupt settings file must never block startup.
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(file, settings) {
  const normalized = normalizeSettings(settings)
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp`
  writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
  return normalized
}
