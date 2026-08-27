<script setup lang="ts">
/**
 * ModelPreview3D —— 设备模型 GLB 实时 3D 缩略预览(共享渲染器版)。
 *
 * 关键设计:模型库有 12+ 张卡,浏览器 WebGL 活动上下文上限 ~16 —— 每卡独立
 * WebGLRenderer 会让排在后面的卡(薄膜双拉系列)上下文被驱逐 → 黑块。
 * 这里改为模块级共享单渲染器:一个 offscreen WebGL canvas + 单 rAF 循环,
 * 逐槽位渲染后 drawImage 到各卡自己的 2D canvas。上下文恒为 1,GPU 占用受控。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'

const props = withDefaults(defineProps<{
  /** 已上传模型 URL(/assets/...) */
  file?: string
  /** 本地待上传文件(优先于 file) */
  localFile?: File | null
  /** 预览区高度 */
  height?: number
}>(), {
  file: '',
  localFile: null,
  height: 64,
})

const hostRef = ref<HTMLDivElement | null>(null)
const failed = ref(false)
const loading = ref(false)

// ---------- 共享渲染器管理器(模块级单例;槽位 = 场景 + 2D 目标画布) ----------
interface Slot {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  group: THREE.Group | null
  w: number
  h: number
  speed: number
}

interface SharedRig {
  renderer: THREE.WebGLRenderer
  slots: Set<Slot>
  raf: number
  clock: THREE.Clock
}

const rigGlobal = globalThis as typeof globalThis & { __modelPreviewRig?: SharedRig }
let objectUrl = ''

function acquireRig(): SharedRig {
  if (rigGlobal.__modelPreviewRig) return rigGlobal.__modelPreviewRig
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.15
  const rig: SharedRig = { renderer, slots: new Set(), raf: 0, clock: new THREE.Clock() }
  const tick = (): void => {
    rig.raf = requestAnimationFrame(tick)
    const dt = rig.clock.getDelta()
    // 逐槽渲染(76px 卡 × ~20 槽 = 极小开销);槽画布不在文档中(卸载竞态)则跳过
    for (const s of rig.slots) {
      if (!s.canvas.isConnected && s.canvas.width === 0) continue
      if (s.group) s.group.rotation.y += dt * s.speed
      rig.renderer.setSize(s.w, s.h, false)
      rig.renderer.render(s.scene, s.camera)
      s.ctx.clearRect(0, 0, s.w, s.h)
      s.ctx.drawImage(rig.renderer.domElement, 0, 0, s.w, s.h)
    }
  }
  tick()
  rigGlobal.__modelPreviewRig = rig
  return rig
}

function releaseRig(): void {
  const rig = rigGlobal.__modelPreviewRig
  if (!rig || rig.slots.size > 0) return
  cancelAnimationFrame(rig.raf)
  rig.renderer.dispose()
  rig.renderer.domElement.remove()
  delete rigGlobal.__modelPreviewRig
}

function buildLighting(scene: THREE.Scene): void {
  try {
    // PBR 环境光:金属/粗糙材质获得反射(无环境的金属 GLB = 纯黑)。
    // PMREM 需要临时借用共享渲染器 —— 与渲染循环串行(同一 JS 线程),安全。
    const pmrem = new THREE.PMREMGenerator(rigGlobal.__modelPreviewRig!.renderer)
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    scene.environmentIntensity = 0.55
    pmrem.dispose()
  }
  catch { /* 环境不可用:退回灯光方案 */ }
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x3a2f25, 1.3))
  const key = new THREE.DirectionalLight(0xfff2df, 2.2)
  key.position.set(3, 4, 2)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x41c8f4, 1.0)
  rim.position.set(-3, 1, -2.5)
  scene.add(rim)
}

function fitObject(obj: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(obj)
  const size = new THREE.Vector3()
  box.getSize(size)
  const center = box.getCenter(new THREE.Vector3())
  const max = Math.max(size.x, Math.max(size.y, size.z)) || 1
  const s = 2 / max
  obj.scale.setScalar(s)
  // 根平移不被自身缩放作用:必须用 center×s 补偿(模型原始中心远离原点时,
  // 裸 center 平移会把物体甩出视野 —— 薄膜双拉系列预览空白即此因)
  obj.position.set(-center.x * s, -center.y * s, -center.z * s)
}

let slot: Slot | null = null

function mountScene(source: string): void {
  if (!hostRef.value || failed.value) return
  const el = hostRef.value
  const w = el.clientWidth || 120
  const h = props.height || 64
  const rig = acquireRig()

  const canvas = document.createElement('canvas')
  canvas.style.width = '100%'
  canvas.style.height = `${h}px`
  canvas.width = Math.max(2, Math.round(w * Math.min(window.devicePixelRatio, 1.5)))
  canvas.height = Math.max(2, Math.round(h * Math.min(window.devicePixelRatio, 1.5)))
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    failed.value = true
    return
  }
  el.appendChild(canvas)

  const scene = new THREE.Scene()
  buildLighting(scene)
  const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 100)
  camera.position.set(2.4, 1.8, 3.1)
  camera.lookAt(0, 0, 0)
  const group = new THREE.Group()
  scene.add(group)

  slot = { canvas, ctx, scene, camera, group, w: canvas.width, h: canvas.height, speed: 0.6 }
  rig.slots.add(slot)

  loading.value = true
  const loader = new GLTFLoader()
  loader.load(source, (glt: unknown) => {
    const obj = (glt as { scene: THREE.Group }).scene
    if (!slot) return
    obj.traverse((c) => {
      const m = c as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = false
        m.receiveShadow = false
      }
    })
    fitObject(obj)
    slot.group!.add(obj)
    loading.value = false
  }, undefined, () => {
    loading.value = false
    failed.value = true
  })
}

function dispose(): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = ''
  if (slot) {
    const rig = rigGlobal.__modelPreviewRig
    rig?.slots.delete(slot)
    // 显存释放:几何/材质/纹理逐项 dispose(场景小,遍历即可)
    slot.scene.traverse((c) => {
      const mesh = c as THREE.Mesh
      if (mesh.isMesh) {
        mesh.geometry?.dispose()
        const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
        for (const mat of mats) {
          for (const key of Object.keys(mat as unknown as Record<string, unknown>)) {
            const v = (mat as unknown as Record<string, unknown>)[key]
            if (v && (v as THREE.Texture).isTexture) (v as THREE.Texture).dispose()
          }
          mat?.dispose()
        }
      }
    })
    slot.canvas.remove()
    slot = null
    releaseRig()
  }
}

function startLoad(): void {
  failed.value = false
  if (props.localFile) {
    objectUrl = URL.createObjectURL(props.localFile)
    mountScene(objectUrl)
    return
  }
  if (props.file) mountScene(props.file)
}

onMounted(startLoad)
watch(() => [props.file, props.localFile], () => {
  dispose()
  const src = props.localFile ?? (props.file ? props.file : null)
  if (src) nextTick(() => startLoad())
})
onBeforeUnmount(dispose)
</script>

<template>
  <div
    ref="hostRef"
    class="model-preview-3d"
    :style="{ height: `${height}px` }"
  >
    <div
      v-if="loading"
      class="mp-loading"
    >
      <span class="mp-spin" />
    </div>
    <div
      v-else-if="failed"
      class="mp-failed"
    >
      PREVIEW NA
    </div>
  </div>
</template>

<style scoped>
.model-preview-3d {
  position: relative;
  width: 100%;
  min-height: 40px;
  background:
    radial-gradient(120% 90% at 50% 20%, rgba(65, 200, 244, 0.12), transparent 62%),
    linear-gradient(180deg, #0b121b, #0e141d);
  border: 1px solid var(--hud-line, #263340);
  border-radius: 2px;
  overflow: hidden;
}
.mp-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
}
.mp-spin {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(65, 200, 244, 0.25);
  border-top-color: #41c8f4;
  border-radius: 50%;
  animation: mp-spin 0.8s linear infinite;
}
@keyframes mp-spin { to { transform: rotate(360deg); } }
.mp-failed {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-family: var(--font-mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  color: var(--hud-dim, #7f919e);
}
</style>
