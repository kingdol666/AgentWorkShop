/**
 * 本地时间安装(nitro 最早装载,文件名 00- 前缀保证排序第一):
 * 全项目 ISO 时间输出统一为本地系统时区(见 shared/local-time.mjs)。
 * 必须先于一切业务插件/路由/日志装载,否则启动期日志仍会输出 UTC。
 */
import { installLocalIso } from '@/shared/local-time.mjs'

export default function localTimePlugin(): void {
  installLocalIso()
}
