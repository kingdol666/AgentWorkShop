/**
 * DCW 驱动边缘层徽标 —— 节点表 / 数据绑定节点选择处共用的极简语义标注。
 *
 * 只给"非自明"的驱动加徽标:
 *  - mes-rest  → MES 边缘层(写控制经 MES REST 边缘链路,协议名不自明);
 *  - mock / s7-stub → 无协议转换(模拟/桩源,提醒其非真实产线链路);
 *  - modbus/opcua/mqtt/http 等真实协议驱动 → 协议名自明,不加徽标。
 *
 * driver 形参放宽为 string:'mes-rest'/'s7-stub' 枚举由后端驱动目录并行加入
 * DcwDriverKind,字面量比较在合入前后均类型安全(避免与未合入的联合类型比对报错)。
 */
export function dcwDriverBadgeKey(driver: string): 'dcwDetail.drvBadgeMes' | 'dcwDetail.drvBadgeNoConv' | null {
  if (driver === 'mes-rest') return 'dcwDetail.drvBadgeMes'
  if (driver === 'mock' || driver === 's7-stub') return 'dcwDetail.drvBadgeNoConv'
  return null
}
