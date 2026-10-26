import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const project = path.resolve(here, '..')
const repo = path.resolve(project, '../../..')
const build = path.resolve(process.env.AW_VIDEO_BUILD ?? path.join(project, '_build'))
const publicDir = path.join(repo, 'docs', 'site', 'public', 'demo')
const ffmpeg = process.env.AW_FFMPEG ?? 'ffmpeg'
const manifest = JSON.parse(fs.readFileSync(path.join(build, 'manifest.json'), 'utf8'))
const fade = Number(manifest.transitionSeconds ?? 0.38)

fs.mkdirSync(publicDir, { recursive: true })
function run(args, options = {}) {
  const result = spawnSync(ffmpeg, args, { stdio: 'inherit', ...options })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`ffmpeg exited with status ${result.status}`)
}
const scenes = manifest.scenes.map(scene => ({
  ...scene,
  duration: scene.end - scene.start,
  video: path.join(build, 'scenes', `${scene.id}.mp4`),
}))
for (const scene of scenes) {
  if (!fs.existsSync(scene.video)) throw new Error(`Missing recorded scene: ${scene.video}`)
}

const enSrt = []
const zhSrt = []
const enVtt = ['WEBVTT', '']
const zhVtt = ['WEBVTT', '']
let cueIndex = 1
const safeTimeline = {
  title: manifest.title,
  voice: manifest.voice,
  sampleRate: manifest.sampleRate,
  durationSeconds: manifest.duration,
  transitionSeconds: fade,
  scenes: [],
}

function stamp(seconds, separator) {
  const millis = Math.max(0, Math.round(seconds * 1000))
  const hh = Math.floor(millis / 3_600_000)
  const mm = Math.floor((millis % 3_600_000) / 60_000)
  const ss = Math.floor((millis % 60_000) / 1000)
  const ms = millis % 1000
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`
}

for (const scene of scenes) {
  safeTimeline.scenes.push({ id: scene.id, start: scene.start, end: scene.end, duration: scene.duration })
  for (const sentence of scene.sentences) {
    const start = sentence.start
    const end = Math.min(sentence.end, start + sentence.duration - 0.05)
    const enText = sentence.enCaption.replace(/\r/g, '').trim()
    const zhText = sentence.zh.replace(/\r/g, '').trim()
    const srtCue = `${cueIndex}\n${stamp(start, ',')} --> ${stamp(end, ',')}\n${enText}\n`
    const zhSrtCue = `${cueIndex}\n${stamp(start, ',')} --> ${stamp(end, ',')}\n${zhText}\n`
    const vttCue = `${stamp(start, '.')} --> ${stamp(end, '.')}\n${enText}\n`
    const zhVttCue = `${stamp(start, '.')} --> ${stamp(end, '.')}\n${zhText}\n`
    enSrt.push(srtCue)
    zhSrt.push(zhSrtCue)
    enVtt.push(vttCue, '')
    zhVtt.push(zhVttCue, '')
    cueIndex++
  }
}

const enSrtPath = path.join(build, 'captions.en.srt')
const zhSrtPath = path.join(build, 'captions.zh-Hans.srt')
fs.writeFileSync(enSrtPath, `${enSrt.join('\n').trim()}\n`, 'utf8')
fs.writeFileSync(zhSrtPath, `${zhSrt.join('\n').trim()}\n`, 'utf8')
fs.writeFileSync(path.join(publicDir, 'agentworkshop-core-demo.en.vtt'), `${enVtt.join('\n').trimEnd()}\n`, 'utf8')
fs.writeFileSync(path.join(publicDir, 'agentworkshop-core-demo.zh-Hans.vtt'), `${zhVtt.join('\n').trimEnd()}\n`, 'utf8')
fs.copyFileSync(enSrtPath, path.join(publicDir, 'agentworkshop-core-demo.en.srt'))
fs.copyFileSync(zhSrtPath, path.join(publicDir, 'agentworkshop-core-demo.zh-Hans.srt'))
fs.writeFileSync(path.join(project, 'timeline.json'), JSON.stringify(safeTimeline, null, 2), 'utf8')

const voiceWav = path.join(build, 'voiceover.wav')
const voiceMp3 = path.join(publicDir, 'agentworkshop-core-demo-voiceover.mp3')
run([
  '-y', '-v', 'error', '-i', voiceWav, '-af', `apad=pad_dur=${fade.toFixed(3)}`,
  '-ar', '44100', '-ac', '2', '-c:a', 'libmp3lame', '-b:a', '160k', voiceMp3,
])

const inputs = []
const filter = []
for (const scene of scenes) inputs.push('-i', scene.video)
inputs.push('-i', voiceWav)
filter.push(`[0:v]setpts=PTS-STARTPTS,fps=30,setsar=1,format=yuv420p[v0]`)
let previous = 'v0'
for (let i = 1; i < scenes.length; i++) {
  filter.push(`[${i}:v]setpts=PTS-STARTPTS,fps=30,setsar=1,format=yuv420p[v${i}]`)
  const current = `v${i}`
  const output = `x${i}`
  const offset = scenes.slice(0, i).reduce((sum, item) => sum + item.duration, 0)
  filter.push(`[${previous}][${current}]xfade=transition=fade:duration=${fade.toFixed(3)}:offset=${offset.toFixed(3)}[${output}]`)
  previous = output
}

const lastVideo = previous
const subtitleFile = path.relative(repo, enSrtPath).replace(/\\/g, '/')
const escapedSubtitleFile = subtitleFile.replace(/^([A-Za-z]):/, '$1\\:')
const subtitleStyle = "FontName=Arial,FontSize=12,PrimaryColour=&H00FFFFFF,OutlineColour=&H800C0A09,BorderStyle=3,Outline=2,Shadow=0,MarginV=14,Alignment=2"
filter.push(`[${lastVideo}]subtitles=filename='${escapedSubtitleFile}':force_style='${subtitleStyle}'[vout]`)
const audioInput = scenes.length
filter.push(`[${audioInput}:a]aformat=sample_rates=44100:channel_layouts=stereo,apad=pad_dur=${fade.toFixed(3)},asetpts=PTS-STARTPTS[aout]`)

const preMux = path.join(build, 'core-demo-burned-en.mp4')
run([
  '-y', ...inputs, '-filter_complex', filter.join(';'),
  '-map', '[vout]', '-map', '[aout]', '-r', '30',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '19',
  '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', preMux,
], { cwd: repo })

const finalVideo = path.join(publicDir, 'agentworkshop-core-demo.mp4')
run([
  '-y', '-v', 'error', '-i', preMux,
  '-i', enSrtPath, '-i', zhSrtPath,
  '-map', '0:v:0', '-map', '0:a:0', '-map', '1:s:0', '-map', '2:s:0',
  '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
  '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=English',
  '-metadata:s:s:1', 'language=zho', '-metadata:s:s:1', 'title=Chinese (Simplified)',
  '-disposition:s:0', '0', '-disposition:s:1', '0', '-movflags', '+faststart', finalVideo,
])

const poster = path.join(project, 'poster.png')
if (!fs.existsSync(poster)) fs.copyFileSync(path.join(project, 'stills', '01-workspace.png'), poster)
fs.copyFileSync(poster, path.join(publicDir, 'agentworkshop-core-demo-poster.png'))
console.log(`Rendered ${finalVideo}`)
