/**
 * 补充验证:minio 适配器真容器 roundtrip + 工厂装配/降级路径。
 * 运行: npx tsx --tsconfig .nuxt/tsconfig.server.json scripts/test-daq-minio.ts
 * 凭据从 config.yml daq.objectstore 读取(单一事实源,不在源码硬编码);
 * 需 daq-minio 容器在 127.0.0.1:9000。
 */
import { readFileSync } from 'node:fs'
import { MinioObjectAdapter } from '../server/services/workshop/daq/objectstore/minio.adapter'
import { rebuildObjectStore, getObjectStore } from '../server/services/workshop/daq/objectstore'

let failures = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

/** 从 config.yml 读 daq.objectstore 段(键值对缩进解析,够用即可) */
function osConfigFromYml(): { endPoint: string, port: number, accessKey: string, secretKey: string, bucket: string } | null {
  const yml = readFileSync('config.yml', 'utf-8')
  const m = yml.match(/^ {2}objectstore:\r?\n((?: {4}.*\r?\n?)+)/m)
  if (!m) return null
  const kv = (key: string, dflt: string): string => (m[1]!.match(new RegExp(`${key}:\\s*(\\S+)`))?.[1] ?? dflt)
  return {
    endPoint: kv('host', '127.0.0.1'),
    port: Number(kv('port', '9000')),
    accessKey: kv('accessKey', 'awshop'),
    secretKey: kv('secretKey', ''),
    bucket: 'daq-e2e-probe',
  }
}

console.log('\n--- MinIO 适配器(真容器)---')
{
  const cfg = osConfigFromYml()
  check('config.yml objectstore 段可读', cfg != null)
  if (cfg) {
    const adapter = new MinioObjectAdapter(cfg)
    let ok = true
    for (let i = 0; i < 3; i++) {
      try {
        await adapter.init()
        break
      }
      catch (err) {
        if (i === 2) {
          ok = false
          console.log('  init 失败:', (err as Error).message)
        }
        await new Promise(r => setTimeout(r, 2000))
      }
    }
    check('init(建连 + 建桶)', ok)
    if (ok) {
      const key = 'probe/test-object.png'
      const payload = Buffer.from([0x89, 0x50, 1, 2, 3, 4])
      await adapter.put(key, payload, 'image/png')
      const back = await adapter.get(key)
      check('put/get 闭环', back.equals(payload))
      await adapter.remove(key)
      check('remove', (await adapter.get(key).then(() => false, () => true)))
      await adapter.close()
    }

    // 工厂装配路径:rebuildObjectStore(online, url) → backend=minio
    const url = `http://${encodeURIComponent(cfg.accessKey)}:${encodeURIComponent(cfg.secretKey)}@${cfg.endPoint}:${cfg.port}/${cfg.bucket}`
    await rebuildObjectStore(true, url)
    check('rebuildObjectStore 装配 minio', getObjectStore().backend === 'minio')
    await getObjectStore().put('probe/factory.txt', Buffer.from('aw'), 'text/plain')
    check('工厂 get 可用(真桶)', (await getObjectStore().get('probe/factory.txt')).toString() === 'aw')
    // 降级路径
    await rebuildObjectStore(false, null)
    check('离线判定 → disk 降级', getObjectStore().backend === 'disk')
  }
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
