import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'

// WSH keeps the updater console-free on Windows. Wait for the old desktop PID
// to leave; no fixed sleep can guarantee the executable has been unlocked.
export const INSTALL_HELPER_SCRIPT = [
  'Set sh = CreateObject("WScript.Shell")',
  'Set env = sh.Environment("PROCESS")',
  'Set fs = CreateObject("Scripting.FileSystemObject")',
  'Sub Finish(result, code)',
  '  On Error Resume Next',
  '  Set output = fs.CreateTextFile(env("AW_UPDATE_RESULT"), True)',
  '  output.WriteLine result',
  '  output.Close',
  '  fs.DeleteFile WScript.ScriptFullName',
  '  WScript.Quit code',
  'End Sub',
  'On Error Resume Next',
  String.raw`Set wmi = GetObject("winmgmts:\\.\root\cimv2")`,
  'If Err.Number <> 0 Then Finish "wait-failed", 1',
  'For attempt = 1 To 120',
  '  Err.Clear',
  '  Set owners = wmi.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE ProcessId=" & CLng(env("AW_UPDATE_PARENT")))',
  '  If Err.Number <> 0 Then Finish "wait-failed", 1',
  '  ownerCount = owners.Count',
  '  If Err.Number <> 0 Then Finish "wait-failed", 1',
  '  If ownerCount = 0 Then Exit For',
  '  WScript.Sleep 500',
  'Next',
  'If ownerCount <> 0 Then Finish "wait-failed", 1',
  'Err.Clear',
  'exitCode = sh.Run("""" & env("AW_UPDATE_INSTALLER") & """ /S", 0, True)',
  'If Err.Number <> 0 Then Finish "launch-failed", 1',
  'If exitCode <> 0 Then Finish "installer-failed", 1',
  'Set output = fs.CreateTextFile(env("AW_UPDATE_RESULT"), True)',
  'output.WriteLine "installed"',
  'output.Close',
  'Err.Clear',
  'sh.Run """" & env("AW_UPDATE_EXE") & """", 1, False',
  'If Err.Number <> 0 Then Finish "restart-failed", 1',
  'fs.DeleteFile WScript.ScriptFullName',
  '',
].join('\r\n')

export const INSTALL_CONFIRMATION = Object.freeze({
  buttons: ['重启并安装', '稍后'],
  defaultId: 1,
  cancelId: 1,
})

/** No environment flag, notification, or completion of a transfer is consent. */
export async function runConfirmedInstall({ confirm, verify, stop, launch }) {
  if ((await confirm())?.response !== 0) return false
  await verify()
  await stop()
  await launch()
  return true
}

export async function readInstallResult(profile) {
  const result = await readFile(join(profile, 'update-install-result.txt'), 'ascii').catch(() => '')
  const code = result.trim()
  return ['pending', 'wait-failed', 'launch-failed', 'installer-failed', 'restart-failed', 'installed'].includes(code)
    ? code
    : null
}

export async function launchInstallHelper({ profile, installer, executable, parentPid = process.pid }) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error('Invalid desktop process ID')
  const scriptPath = join(profile, `update-helper-${randomUUID()}.vbs`)
  const resultPath = join(profile, 'update-install-result.txt')
  const root = process.env.SystemRoot || 'C:\\Windows'
  try {
    await writeFile(scriptPath, INSTALL_HELPER_SCRIPT, { encoding: 'ascii', flag: 'wx' })
    await writeFile(resultPath, 'pending\n', 'ascii')
    const child = spawn(win32.join(root, 'System32', 'wscript.exe'), ['//B', '//NoLogo', scriptPath], {
      env: {
        ...process.env,
        AW_UPDATE_PARENT: String(parentPid),
        AW_UPDATE_INSTALLER: installer,
        AW_UPDATE_EXE: executable,
        AW_UPDATE_RESULT: resultPath,
      },
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    child.unref()
  }
  catch (err) {
    await unlink(scriptPath).catch(() => {})
    await writeFile(resultPath, 'launch-failed\n', 'ascii').catch(() => {})
    throw err
  }
}
