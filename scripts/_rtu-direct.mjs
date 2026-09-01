/** 一次性:15030 直连测试 */
import { modbusRtuDriver } from '../server/services/workshop/daq/drivers.ts'

const t = await modbusRtuDriver.test({ host: '127.0.0.1', port: 15030, unitId: 1, register: 40001, dataType: 'uint16' })
console.log('direct test:', t.ok, '|', t.message)
process.exit(0)
