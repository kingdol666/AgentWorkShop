/**
 * AgentTeam RPG 小镇(Three.js 3D 表现层)— GLB 加载与 PBR 材质增强。
 *
 * 自 TownScene3D.ts 抽出(角色与设备共用的模型装配底座):
 *  - loadGltf:GLTFLoader 包装(动画 clip 必须在解析层保留);
 *  - loadGltfToGroup:按高度归一化 scale 挂进 Group + 静态子树矩阵冻结(设备路径);
 *  - enhancePbrMaterials:就地材质增强(角色哑光 / 设备分级反射与 HDR 指示灯)。
 *
 * 宿主契约:场景类实现 ModelHost(只列本模块触达的成员)。
 */
import * as THREE from 'three'
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'

/** 模型装配模块的宿主契约(一项 = 本模块真正用到的字段/方法) */
export interface ModelHost {
  readonly gltfLoader: GLTFLoader
  /** 请求下一帧重绘 */
  markDirty(): void
}

export function loadGltf(loader: GLTFLoader, file: string): Promise<{ scene: THREE.Group, animations: THREE.AnimationClip[] }> {
  return new Promise((resolve, reject) => {
    loader.load(file, gltf => resolve({ scene: gltf.scene as THREE.Group, animations: gltf.animations ?? [] }), undefined, reject)
  })
}

/** 将 GLB 加载进 Group(按高度归一化 scale) */
export async function loadGltfToGroup(host: ModelHost, file: string, group: THREE.Group, targetH: number): Promise<void> {
  try {
    const gltf = await loadGltf(host.gltfLoader, file)
    const box = new THREE.Box3().setFromObject(gltf.scene)
    const h = Math.max(0.5, box.max.y - box.min.y)
    const scale = targetH / h
    gltf.scene.scale.setScalar(scale)
    gltf.scene.position.y = 0
    // 真实投影 + PBR 材质增强(设备:金属机身材质反射拉满,像真实工业设备)
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true
    })
    enhancePbrMaterials(host, gltf.scene, 'device')
    // 静态子树矩阵冻结:设备模型加载后局部变换恒定,子孙 matrixAutoUpdate=false +
    // 一次性 updateMatrix,免每帧全树 updateMatrix 合成(拖拽/缩放只改祖先链,
    // world 矩阵经 force 传播仍正确;设备无动画,mixer 仅角色路径使用)
    gltf.scene.traverse((o) => {
      if (o === gltf.scene) return
      o.matrixAutoUpdate = false
      o.updateMatrix()
    })
    group.add(gltf.scene)
  }
  catch {
    // 加载失败:空 Group,静默(节点仍存在,只是无网格)
  }
}

/**
 * 模型 PBR 材质增强(放入场景后的渲染优化;设备/角色分治)。
 * 根因修复:角色与产线设备 GLB 大量使用 KHR_materials_unlit(three 加载为
 * MeshBasicMaterial),不受灯光/阴影约束,夜景里像自发光贴片 —— 这既是
 * 「角色过亮」也是设备「假金属光泽」的来源。统一就地转标准材质接入光照
 * 体系,再分级调参:
 * - 角色:哑光 + 极轻环境反射(无清漆/自发光,保持原作贴图观感);
 * - 设备:LED 指示灯保持无光照语义并提 HDR(bloom 起晕,幂等防重);
 *   透光件微自发光 / 金属件适度镜面(0.85,克制)/ 烤漆件轻清漆。
 */
export function enhancePbrMaterials(host: ModelHost, root: THREE.Object3D, kind: 'device' | 'character'): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.receiveShadow = true
    const tune = (raw: THREE.Material): THREE.Material => {
      const b = raw as THREE.MeshBasicMaterial & { isMeshBasicMaterial?: boolean }
      let m: THREE.MeshStandardMaterial
      if (b?.isMeshBasicMaterial) {
        if (kind === 'device' && /led|lamp|light/i.test(b.name ?? '')) {
          // 设备指示灯:保持无光照语义;提为 HDR(bloom 起晕)。clone 共享同一材质,
          // userData 幂等护桥避免多实例挂载时倍率叠乘。
          const flag = (b.userData ?? (b.userData = {})) as { hdrBoost?: boolean }
          if (!flag.hdrBoost) {
            b.color.multiplyScalar(4.5)
            flag.hdrBoost = true
          }
          return b
        }
        m = new THREE.MeshStandardMaterial({
          map: b.map ?? null,
          // unlit 贴图按"全亮"绘制,直接接入 ~8 倍总光的灯光系会过曝成白炽;
          // 反照率按类型压暗:角色 0.4 / 设备 0.55(ACES 肩部回落到合理亮度)
          color: b.color.clone().multiplyScalar(kind === 'character' ? 0.38 : 0.5),
          transparent: b.transparent,
          opacity: b.opacity,
          alphaTest: b.alphaTest,
          side: b.side,
          roughness: kind === 'character' ? 0.92 : 0.6,
          metalness: kind === 'character' ? 0 : 0.25,
        })
        m.name = b.name ?? ''
        b.dispose()
      }
      else {
        const s = raw as THREE.MeshStandardMaterial
        if (!s || !('envMapIntensity' in s)) return raw
        m = s
      }
      if (kind === 'character') {
        // 角色:哑光 + 极轻环境反射(曾因 emissive 底光 + 清漆层整体过亮)
        m.envMapIntensity = 0.45
        if (m.metalness > 0.3) m.metalness = 0
        return m
      }
      // 设备分级
      if (m.transparent) {
        // 灯罩/屏幕/指示窗:轻微自发光,像通电的设备部件
        m.envMapIntensity = 0.42
        if (m.emissive) m.emissive.setScalar(Math.max(m.emissive.r, 0.06))
        return m
      }
      if (m.metalness >= 0.5) {
        m.envMapIntensity = 0.85 // 金属机身:适可而止的镜面(1.35 曾过亮)
        return m
      }
      // 涂装/塑料外壳 → 物理材质轻清漆层(已是物理材质只调参,避免 clone 共享材质重复替换)
      if ((m as unknown as { isMeshPhysicalMaterial?: boolean }).isMeshPhysicalMaterial) {
        const p = m as THREE.MeshPhysicalMaterial
        p.clearcoat = 0.35
        p.clearcoatRoughness = 0.4
        p.envMapIntensity = 0.7
        p.needsUpdate = true
        return p
      }
      const p = new THREE.MeshPhysicalMaterial({
        color: m.color,
        map: m.map,
        normalMap: m.normalMap,
        roughnessMap: m.roughnessMap,
        aoMap: m.aoMap,
        emissive: m.emissive,
        emissiveMap: m.emissiveMap,
        emissiveIntensity: m.emissiveIntensity,
        roughness: Math.min(m.roughness, 0.55),
        metalness: m.metalness,
        clearcoat: 0.35,
        clearcoatRoughness: 0.4,
      })
      p.name = m.name
      p.side = m.side
      m.dispose()
      return p
    }
    if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(tune)
    else mesh.material = tune(mesh.material)
  })
  host.markDirty()
}
