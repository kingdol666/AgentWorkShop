/**
 * 本地时间安装(nitro 最早装载,文件名 00- 前缀保证排序第一):
 * 全项目 ISO 时间输出统一为本地系统时区(见 shared/local-time.mjs)。
 * 必须先于一切业务插件/路由/日志装载,否则启动期日志仍会输出 UTC。
 */
import { installLocalIso, setConfiguredTimeZone, DEFAULT_TIME_ZONE } from '@/shared/local-time.mjs'

export default function localTimePlugin(): void {
  // 00 插件必须保持纯启动底座:不能提前创建 SystemConfigService 单例,
  // 否则后续 system-config 插件会误判已初始化而跳过 descriptor 加载。
  setConfiguredTimeZone(DEFAULT_TIME_ZONE)
  installLocalIso()
}
