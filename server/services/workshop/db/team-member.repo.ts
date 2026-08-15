/**
 * TeamMember 仓储:team_members 表(team × agent 模板 成员关系)。
 * 一个 team 可含多个 Agent 模板;同一模板在同一 team 内唯一(复合主键)。
 * 工厂接收 DatabaseSync(依赖注入),不持有任何单例。
 */
import type { DatabaseSync } from 'node:sqlite'
import type { TeamMemberRow } from './database'

export interface TeamMemberAddInput {
  teamId: string
  templateId: string
  role: 'lead' | 'worker'
}

/** team_members 表仓储契约 */
export interface TeamMemberRepo {
  /** 加入成员;重复加入抛约束错误(SQLITE_CONSTRAINT,由上层转 409) */
  add(input: TeamMemberAddInput): TeamMemberRow
  /** team 内全部成员(按加入顺序) */
  listByTeam(teamId: string): TeamMemberRow[]
  findByTeamTemplate(teamId: string, templateId: string): TeamMemberRow | undefined
  /** 某模板加入的全部 team(跨 team) */
  listByTemplate(templateId: string): TeamMemberRow[]
  /** team 内 lead 数量(约束一个 team 至多一个 lead) */
  countLead(teamId: string): number
  /** 移除成员(仅删关系,不删模板) */
  remove(teamId: string, templateId: string): void
}

const COLS = 'team_id AS teamId, template_id AS templateId, role, created_at AS createdAt'

export function createTeamMemberRepo(db: DatabaseSync): TeamMemberRepo {
  const insert = db.prepare(
    `INSERT INTO team_members (team_id, template_id, role, created_at)
     VALUES (?, ?, ?, ?)`,
  )
  const selectByTeam = db.prepare(`SELECT ${COLS} FROM team_members WHERE team_id = ? ORDER BY created_at ASC`)
  const selectByTeamTemplate = db.prepare(`SELECT ${COLS} FROM team_members WHERE team_id = ? AND template_id = ?`)
  const selectByTemplate = db.prepare(`SELECT ${COLS} FROM team_members WHERE template_id = ? ORDER BY created_at ASC`)
  const removeStmt = db.prepare(`DELETE FROM team_members WHERE team_id = ? AND template_id = ?`)
  const selectLeads = db.prepare(`SELECT ${COLS} FROM team_members WHERE team_id = ? AND role = 'lead'`)

  return {
    add(input: TeamMemberAddInput): TeamMemberRow {
      const now = new Date().toISOString()
      insert.run(input.teamId, input.templateId, input.role, now)
      return { teamId: input.teamId, templateId: input.templateId, role: input.role, createdAt: now }
    },

    listByTeam(teamId: string): TeamMemberRow[] {
      return selectByTeam.all(teamId) as unknown as TeamMemberRow[]
    },

    findByTeamTemplate(teamId: string, templateId: string): TeamMemberRow | undefined {
      return selectByTeamTemplate.get(teamId, templateId) as unknown as TeamMemberRow | undefined
    },

    listByTemplate(templateId: string): TeamMemberRow[] {
      return selectByTemplate.all(templateId) as unknown as TeamMemberRow[]
    },

    countLead(teamId: string): number {
      return (selectLeads.all(teamId) as unknown as TeamMemberRow[]).length
    },

    remove(teamId: string, templateId: string): void {
      removeStmt.run(teamId, templateId)
    },
  }
}
