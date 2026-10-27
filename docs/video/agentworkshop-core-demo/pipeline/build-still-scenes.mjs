import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(here, '..')
const build = path.resolve(process.env.AW_VIDEO_BUILD ?? path.join(project, '_build'))
const stills = path.join(project, 'stills')
const ffmpeg = process.env.AW_FFMPEG ?? 'ffmpeg'
const manifest = JSON.parse(fs.readFileSync(path.join(build, 'manifest.json'), 'utf8'))

function run(args) {
  const result = spawnSync(ffmpeg, args, { stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`ffmpeg exited with status ${result.status}`)
}

for (const scene of manifest.scenes.filter(item => item.id === '04-line-context' || item.sourceStill)) {
  const source = path.join(stills, scene.sourceStill ?? `${scene.id}.png`)
  const still = path.join(stills, `${scene.id}.png`)
  const clip = path.join(build, 'scenes', `${scene.id}.mp4`)
  if (!fs.existsSync(source)) throw new Error(`Missing source screenshot: ${source}`)

  if (scene.id === '05-line-standby') {
    run(['-y', '-v', 'error', '-i', source, '-vf', 'crop=500:282:238:365,scale=1600:900:flags=lanczos', '-frames:v', '1', still])
  }
  else if (scene.id === '06-mock-boundary') {
    run(['-y', '-v', 'error', '-i', source, '-vf', 'crop=600:338:238:388,scale=1600:900:flags=lanczos', '-frames:v', '1', still])
  }
  else if (path.resolve(source) !== path.resolve(still)) {
    fs.copyFileSync(source, still)
  }

  const duration = scene.end - scene.start + manifest.transitionSeconds
  fs.mkdirSync(path.dirname(clip), { recursive: true })
  run([
    '-y', '-v', 'error', '-loop', '1', '-framerate', '30', '-i', still,
    '-t', duration.toFixed(3),
    '-vf', 'zoompan=z=\'min(zoom+0.00008,1.035)\':x=\'iw/2-(iw/zoom/2)\':y=\'ih/2-(ih/zoom/2)\':d=1:s=1600x900:fps=30,format=yuv420p',
    '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', clip,
  ])
  console.log(`Built ${scene.id} from ${scene.sourceStill}: ${duration.toFixed(2)}s`)
}
