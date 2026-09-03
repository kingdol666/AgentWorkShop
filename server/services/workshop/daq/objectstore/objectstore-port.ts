/**
 * DaqObjectStore 端口(hexagonal seam)—— 图像等非结构化帧数据的持久化出口。
 *
 * 分工约定(plan D1/D3):Timescale 存帧元数据(daq_frames.meta.objectKey),
 * 像素 blob 只落对象存储;实现:
 *  - minio.adapter —— S3 兼容(compose daq-minio;DAQ_OS_URL / config daq.objectstore 启用)
 *  - disk.adapter  —— 本地磁盘降级(data/daq-objects/;MinIO 不可达时自动切换,采集不中断)
 */

export interface DaqObjectStore {
  /** 后端标识(minio | disk)——REST meta 直报前端 */
  readonly backend: string
  init(): Promise<void>
  put(key: string, data: Buffer, contentType: string): Promise<void>
  get(key: string): Promise<Buffer>
  remove(key: string): Promise<void>
  close?(): Promise<void> | void
}

/** 对象键生成(daq/<nodeId>/<yyyy>/<mm>/<dd>/<ts><suffix>) */
export function daqObjectKey(nodeId: string, tsMs: number, ext: string): string {
  const d = new Date(tsMs)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `daq/${nodeId}/${yyyy}/${mm}/${dd}/${tsMs}${ext}`
}
