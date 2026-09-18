/**
 * pg 的最小环境声明(补第三方**缺失的类型**,不是屏蔽错误)。
 *
 * 依据(实测 node_modules/pg@8.23.0):
 *  - package.json 无 "types"/"typings" 字段,files 只有 lib / esm/SPONSORS.md —— 包内**零 .d.ts**;
 *    仓库也未安装 @types/pg(实测 node_modules/@types 只有 js-yaml / node / three),
 *    所以 `import type { Pool } from 'pg'` 必然 TS7016(隐式 any)。
 *  - exports["."].import → ./esm/index.mjs(TS7016 报的就是该文件);运行时导出面见 lib/index.js
 *    (Pool / Client / types 等),本文件只声明代码真正用到的成员。
 *  - 行值形状由 SQL 与 pg 的 type parser 在运行时决定(timestamptz → Date、float8 → number、
 *    count(*) → string),查询期无法静态得知 —— 与官方 @types/pg 一致,用索引签名表达"逐查询动态";
 *    需要窄化的查询点在调用侧显式断言(见 timescale.adapter.ts queryTagged 的 rows as Array<{...}>)。
 *
 * 覆盖范围:server/services/workshop/daq/storage/timescale.adapter.ts 的用法
 * (Pool 构造 / query(sql[, values]) / connect()→query+release / end())。新增用法时按需扩展。
 */
declare module 'pg' {
  /** 行对象形状逐查询动态(官方 @types/pg 同样用索引签名表达) */
  export interface QueryResultRow {
    [column: string]: any
  }

  export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
    rows: R[]
    rowCount: number | null
    command: string
  }

  export interface PoolConfig {
    connectionString?: string
    max?: number
    min?: number
    idleTimeoutMillis?: number
    connectionTimeoutMillis?: number
  }

  /** 池借出的连接:复合语句事务(BEGIN/COMMIT/ROLLBACK)与参数化查询 */
  export interface PoolClient {
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>
    release(err?: Error | boolean): void
  }

  export class Pool {
    constructor(config?: PoolConfig)
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<QueryResult<R>>
    connect(): Promise<PoolClient>
    end(): Promise<void>
  }
}
