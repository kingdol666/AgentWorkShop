import { spawnSync } from 'node:child_process'
import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const desktop = dirname(fileURLToPath(import.meta.url))
const help = `Usage: npm run build -- --backend <installed agentworkshop directory> [options]

Run on Windows x64 with Node.js 24 and npm ci in desktop/. Supply a clean npm
pack candidate installed with npm install -g --omit=dev --prefix <empty dir>
<agentworkshop.tgz> on Windows x64. The backend path is its node_modules/agentworkshop
folder, not the checkout, a tarball, or a local npm install with hoisted modules.

  --node-bin <path>      Trusted standalone Node.js 24 x64 .exe (default: build Node)
  --node-license <path>  Node.js distribution LICENSE (default: sibling of the exe)
  --out <path>           New output directory outside the checkout (default: OS temp)
  --stage-only           Copy and validate resources without producing an installer
  --help                 Show this help
`

function within(parent, child) {
  const rel = relative(parent, child)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

async function requireFile(path) {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular file: ${path}`)
}

// Only files from the production npm payload belong at the backend root.
const backendEntries = new Set([
  '.AgentWorkShop', '.env.example', '.output', 'LICENSE', 'README-zh.md', 'README.md',
  'app', 'bin', 'cli', 'config.yml', 'desktop', 'docker-compose.yml', 'docs', 'i18n', 'mcp',
  'node_modules', 'nuxt.config.ts', 'package.json', 'public', 'scripts', 'sdk',
  'server', 'shared', 'skills', 'tsconfig.json', 'tui', 'uno.config.ts',
])
const generatedEntry = /^(?:__pycache__|\.cache|\.nuxt|\.npm|\.pnpm-store|\.runtime|\.turbo|\.venv)$/i
const generatedFile = /\.(?:log|pid|pyc|pyo|sqlite3?(?:-wal|-shm)?)$/i
const privateEntry = /^(?:\.git|\.env(?:\..+)?|\.npmrc|\.netrc|\.pypirc|\.aws|\.ssh|auth\.json|credentials\.json)$|\.(?:key|p12|pfx)$/i

async function copyTree(source, target, backendRoot = source) {
  await mkdir(target)
  const fromRoot = relative(backendRoot, source)
  const desktopShell = fromRoot === 'desktop'
  const electronPackage = fromRoot === join('node_modules', 'electron')
  const files = []
  async function flush() {
    // Wait for the entire batch before aborting so cleanup cannot race a copy.
    const results = await Promise.allSettled(files.splice(0))
    const failure = results.find(result => result.status === 'rejected')
    if (failure) throw failure.reason
  }
  const entries = (await readdir(source, { withFileTypes: true })).filter((entry) => {
    const from = join(source, entry.name)
    if (!entry.isFile() && !entry.isDirectory()) {
      throw new Error(`Refusing to package a symbolic link, junction, or special file: ${from}`)
    }
    if (entry.name !== '.env.example' && privateEntry.test(entry.name)) {
      throw new Error(`Refusing to package a potentially private file or directory: ${from}`)
    }
    if (generatedEntry.test(entry.name) || (entry.isFile() && generatedFile.test(entry.name))) return false
    // The app has its own Electron distribution; a previous npm launch may have expanded this one.
    if (electronPackage && (entry.name === 'dist' || entry.name === 'path.txt')) return false
    if ((fromRoot === '' && !backendEntries.has(entry.name))
      || (desktopShell && !['package.json', 'main.mjs', 'sidecar.mjs', 'update.mjs', 'chrome', 'build'].includes(entry.name))) {
      throw new Error(`Unexpected entry in installed backend: ${from}`)
    }
    return true
  })
  for (const entry of entries) {
    const from = join(source, entry.name)
    const to = join(target, entry.name)
    if (entry.isDirectory()) {
      if (files.length) await flush()
      await copyTree(from, to, backendRoot)
    }
    else {
      files.push(copyFile(from, to, constants.COPYFILE_EXCL))
      if (files.length === 16) await flush()
    }
  }
  if (files.length) await flush()
}

async function validateNode(exe) {
  const handle = await open(exe)
  try {
    const dos = Buffer.alloc(64)
    const pe = Buffer.alloc(6)
    if ((await handle.read(dos, 0, dos.length, 0)).bytesRead !== dos.length
      || dos.readUInt16LE(0) !== 0x5a4d
      || (await handle.read(pe, 0, pe.length, dos.readUInt32LE(0x3c))).bytesRead !== pe.length
      || pe.readUInt32LE(0) !== 0x4550 || pe.readUInt16LE(4) !== 0x8664) {
      throw new Error(`Expected a Windows x64 executable: ${exe}`)
    }
  }
  finally {
    await handle.close()
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(NODE_OPTIONS|NODE_PATH|NODE_V8_COVERAGE|ELECTRON_RUN_AS_NODE)$/i.test(key)))
  const probe = spawnSync(exe, ['-p', 'JSON.stringify([process.versions.node,process.platform,process.arch,Boolean(process.versions.electron)])'], {
    cwd: desktop, encoding: 'utf8', env, timeout: 10_000, windowsHide: true,
  })
  if (probe.error || probe.status !== 0) throw new Error(`Could not run the standalone Node executable: ${exe}`, { cause: probe.error })
  const [version, platform, arch, electron] = JSON.parse(probe.stdout)
  if (!/^24\.\d+\.\d+$/.test(version) || platform !== 'win32' || arch !== 'x64' || electron !== false) {
    throw new Error(`Expected standalone Node.js 24 for win32-x64; got ${probe.stdout.trim()}`)
  }
  return version
}

async function checkBackend(root) {
  const metadata = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  if (metadata.name !== 'agentworkshop' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(metadata.version)) {
    throw new Error('The installed backend must be the agentworkshop npm package with a valid version')
  }
  // Check the sidecar entry points, built UI, and the required Windows SQLite extension.
  for (const file of [
    '.output/server/index.mjs', 'scripts/start.mjs', 'scripts/home-bootstrap.mjs',
    '.output/.AgentWorkShop/aml-python/requirements.txt', '.output/.AgentWorkShop/optimizer-python/worker.py',
    'node_modules/sqlite-vec-windows-x64/vec0.dll',
  ]) await requireFile(join(root, file))
  for (const dir of ['.output/public/_nuxt', '.output/skills', 'node_modules']) {
    if (!(await lstat(join(root, dir))).isDirectory()) throw new Error(`Missing installed backend directory: ${dir}`)
  }
  for (const dependency of Object.keys(metadata.dependencies ?? {})) {
    await requireFile(join(root, 'node_modules', dependency, 'package.json'))
  }
  return metadata.version
}

async function createOutput(requested, checkout, backend) {
  const path = requested && resolve(requested)
  const base = await realpath(path ? dirname(path) : tmpdir())
  const entry = path ? join(base, basename(path)) : base
  if (within(checkout, entry) || within(backend, entry)) {
    throw new Error('Build output must be outside the checkout and the installed backend')
  }
  if (path) {
    await mkdir(entry) // Deliberately refuse to overwrite/reuse any previous output.
    return entry
  }
  return mkdtemp(join(base, 'aw-desktop-'))
}

async function run() {
  const { values: args } = parseArgs({ options: {
    'backend': { type: 'string' }, 'node-bin': { type: 'string' }, 'node-license': { type: 'string' },
    'out': { type: 'string' }, 'stage-only': { type: 'boolean' }, 'help': { type: 'boolean', short: 'h' },
  } })
  if (args.help) {
    console.log(help)
    return
  }
  if (!args.backend) throw new Error(`--backend is required\n\n${help}`)
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24') {
    throw new Error('Build on Windows x64 using standalone Node.js 24 x64')
  }
  const checkout = await realpath(join(desktop, '..'))
  const backendInput = resolve(args.backend)
  if (!(await lstat(backendInput)).isDirectory()) throw new Error('The backend root must not be a symbolic link or junction')
  const backend = await realpath(backendInput)
  if (within(checkout, backend) || basename(backend) !== 'agentworkshop' || basename(dirname(backend)) !== 'node_modules'
    || (await readdir(dirname(backend))).some(name => !name.startsWith('.') && name !== 'agentworkshop')) {
    throw new Error('Use agentworkshop installed alone into an isolated npm global prefix, outside the checkout')
  }
  const nodeSource = resolve(args['node-bin'] ?? process.execPath)
  if (extname(nodeSource).toLowerCase() !== '.exe') throw new Error('--node-bin must point to a trusted standalone Node.js .exe')
  await requireFile(nodeSource)
  const nodeLicense = resolve(args['node-license'] ?? join(dirname(nodeSource), 'LICENSE'))
  await requireFile(nodeLicense)

  const out = await createOutput(args.out, checkout, backend)
  const staged = join(out, 'resources')
  const nodeDir = join(staged, 'node')
  const stagedBackend = join(staged, 'backend')
  let keepStage = false
  try {
    await mkdir(staged)
    await mkdir(nodeDir)
    await copyFile(nodeSource, join(nodeDir, 'node.exe'), constants.COPYFILE_EXCL)
    const nodeVersion = await validateNode(join(nodeDir, 'node.exe'))
    await copyFile(nodeLicense, join(nodeDir, 'LICENSE'), constants.COPYFILE_EXCL)
    console.log(`Staging backend in ${stagedBackend}`)
    await copyTree(backend, stagedBackend)
    const version = await checkBackend(stagedBackend)
    console.log(`Staged AgentWorkShop ${version} with Node.js ${nodeVersion} x64 in ${staged}`)
    if (args['stage-only']) {
      keepStage = true
      return
    }

    const { Arch, Platform, build } = await import('electron-builder')
    const { devDependencies } = JSON.parse(await readFile(join(desktop, 'package.json'), 'utf8'))
    // Keep compression practical for the full npm tree; an explicit builder override still wins.
    process.env.ELECTRON_BUILDER_COMPRESSION_LEVEL ??= '5'
    const artifacts = await build({
      projectDir: desktop,
      targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
      publish: 'never',
      config: {
        extends: null,
        appId: 'com.agentworkshop.desktop',
        productName: 'AgentWorkShop',
        electronVersion: devDependencies.electron,
        // One-click NSIS uses the package name for the per-user install folder.
        extraMetadata: { name: 'agentworkshop', version },
        directories: { output: out },
        files: ['main.mjs', 'sidecar.mjs', 'update.mjs', 'chrome/**/*', 'build/*.png'],
        asar: true,
        npmRebuild: false,
        publish: null,
        win: { executableName: 'AgentWorkShop', icon: 'build/icon.ico', signExecutable: false },
        nsis: {
          artifactName: 'AgentWorkShop-Setup-${version}-win-${arch}.${ext}',
          installerIcon: 'build/icon.ico',
          uninstallerIcon: 'build/icon.ico',
          oneClick: true,
          perMachine: false,
          packElevateHelper: false,
          runAfterFinish: false,
          differentialPackage: false,
        },
        // Stage outside ASAR. Builder file matching can exclude node_modules and dotfiles;
        // moving the validated tree as a unit preserves the exact installed npm payload.
        async afterPack({ appOutDir }) {
          const resources = join(appOutDir, 'resources')
          await rename(stagedBackend, join(resources, 'backend'))
          await rename(nodeDir, join(resources, 'node'))
        },
      },
    })
    console.log(`Installer: ${artifacts.join(', ')}`)
  }
  finally {
    if (!keepStage) await rm(staged, { recursive: true, force: true, maxRetries: 3 })
  }
}

run().catch((err) => {
  console.error(`Desktop build failed: ${err.message}`)
  process.exitCode = 1
})
