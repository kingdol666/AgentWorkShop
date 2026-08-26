<script setup lang="ts">
/**
 * ModelPreview3D —— 设备模型 GLB 实时 3D 缩略预览。
 *
 * 用独立的小 WebGL 场景渲染模型真实几何形状(自动旋转、适配居中),
 * 替换设备库里的占位图标卡。支持:
 *  - 服务端已上传文件(file URL)
 *  - 本地待上传文件(localFile: File → objectURL,上传前即可预览确认)
 * 画布 pointer-events: none,不干扰卡片拖拽到小镇场景。
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

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

let renderer: THREE.WebGLRenderer | null = null
let raf = 0
let modelGroup: THREE.Group | null = null
let objectUrl = ''

function dispose(): void {
  cancelAnimationFrame(raf)
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  objectUrl = ''
  if (renderer) {
    renderer.dispose()
    renderer.domElement.remove()
    renderer = null
  }
  modelGroup = null
}

function fitObject(obj: THREE.Object3D): void {
  const box = new THREE.Box3().setFromObject(obj)
  const size = new THREE.Vector3()
  box.getSize(size)
  const max = Math.max(size.x, Math.max(size.y, size.z)) || 1
  obj.position.x -= box.min.x + size.x / 2
  obj.position.y -= box.min.y + size.y / 2
  obj.position.z -= box.min.z + size.z / 2
  obj.scale.setScalar(2 / max)
}

function mountScene(source: string | ArrayBuffer, onFail?: () => void): void {
  if (!hostRef.value || failed.value) return
  const el = hostRef.value
  const w = el.clientWidth || 120
  const h = props.height || 64

  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false, powerPreference: 'low-power' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    renderer.setSize(w, h)
    renderer.domElement.style.width = '100%'
    renderer.domElement.style.height = `${h}px`
    renderer.domElement.style.pointerEvents = 'none'
    el.appendChild(renderer.domElement)
  }

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 100)
  camera.position.set(2.4, 1.8, 3.1)
  camera.lookAt(0, 0, 0)
  scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x3a2f25, 1.1))
  const key = new THREE.DirectionalLight(0xfff2df, 1.6)
  key.position.set(3, 4, 2)
  scene.add(key)
  const rim = new THREE.DirectionalLight(0x4fa8ff, 0.9)
  rim.position.set(-3, 1, -2.5)
  scene.add(rim)

  modelGroup = new THREE.Group()
  scene.add(modelGroup)

  const loader = new GLTFLoader()
  loading.value = true
  const finish = (): void => {
    loading.value = false
  }
  const parseSrc = (buf: ArrayBuffer): Promise<THREE.Group> => new Promise((res, rej) => {
    loader.parse(buf, '', (glt: unknown) => res((glt as { scene: THREE.Group }).scene), rej)
  })
  const fetchSrc = (url: string): Promise<THREE.Group> => new Promise((res, rej) => {
    loader.load(url, (glt: unknown) => res((glt as { scene: THREE.Group }).scene), undefined, rej)
  })
  const loadSrc: Promise<THREE.Group> = source instanceof ArrayBuffer ? parseSrc(source) : fetchSrc(source)

  loadSrc.then((obj) => {
    const g = modelGroup
    if (!g) {
      finish()
      return
    }
    obj.traverse((c) => {
      const m = c as THREE.Mesh
      if (m.isMesh) {
        m.castShadow = false
        m.receiveShadow = false
      }
    })
    fitObject(obj)
    g.add(obj)
    finish()
  }).catch(() => {
    finish()
    failed.value = true
    onFail?.()
  })

  const clock = new THREE.Clock()
  const tick = (): void => {
    if (!renderer) return
    raf = requestAnimationFrame(tick)
    const dt = clock.getDelta()
    if (modelGroup) modelGroup.rotation.y += dt * 0.6
    renderer.render(scene, camera)
  }
  tick()
}

function startLoad(): void {
  failed.value = false
  if (props.localFile) {
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = URL.createObjectURL(props.localFile)
    mountScene(objectUrl)
    return
  }
  if (props.file) mountScene(props.file)
}

onMounted(startLoad)
watch(() => [props.file, props.localFile], () => {
  // 文件变更:清空重建(多实例自动旋转状态独立)
  dispose()
  const src = props.localFile ?? (props.file ? props.file : null)
  if (src && hostRef.value) {
    if (props.localFile) {
      if (objectUrl) URL.revokeObjectURL(objectUrl)
      objectUrl = URL.createObjectURL(props.localFile)
      mountScene(objectUrl)
    }
    else {
      mountScene(props.file)
    }
  }
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
    radial-gradient(120% 90% at 50% 20%, rgba(79, 168, 255, 0.14), transparent 62%),
    linear-gradient(180deg, #0b121b, #0e141d);
  border: 1px solid var(--hud-line, #2a3844);
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
  border: 2px solid rgba(79, 168, 255, 0.25);
  border-top-color: #4fa8ff;
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
