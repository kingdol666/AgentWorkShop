/**
 * AML 验收脚本的 Python 子进程运行助手(供 acceptance-*.ts 复用)。
 * spawnSync 参数数组、无 shell;返回退出码与日志尾。
 */
import { spawnSync } from 'node:child_process'

export function runPythonJob(pythonBin, args, cwd, envExtra) {
  const r = spawnSync(pythonBin, args, {
    cwd,
    env: { ...process.env, ...envExtra },
    encoding: 'utf8',
    timeout: 300000,
    windowsHide: true,
  })
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split('\n').slice(-6).join(' | ')
  return { code: r.status ?? -1, tail }
}
