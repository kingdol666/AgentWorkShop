import type { Paginated, User, UserListQuery } from '../types/user'
import type { UserCreate, UserUpdate } from '../schemas/user.schema'

/**
 * 用户数据访问层（Repository）
 * 当前为内存实现（进程重启即重置），仅作示例基准。
 * 接入数据库（Prisma / Drizzle / 直连 SQL）时只需替换本文件实现，接口保持不变，
 * service 层零改动 —— 数据源与业务逻辑解耦。
 */

const users: User[] = [
  { id: '1', name: '张伟', email: 'zhangwei@awshop.io', role: 'admin', status: 'active', createdAt: '2026-07-01 09:24:00' },
  { id: '2', name: '王芳', email: 'wangfang@awshop.io', role: 'editor', status: 'active', createdAt: '2026-07-03 14:10:00' },
  { id: '3', name: '李娜', email: 'lina@awshop.io', role: 'user', status: 'disabled', createdAt: '2026-07-05 16:42:00' },
  { id: '4', name: '刘洋', email: 'liuyang@awshop.io', role: 'editor', status: 'active', createdAt: '2026-07-08 11:05:00' },
  { id: '5', name: '陈静', email: 'chenjing@awshop.io', role: 'user', status: 'active', createdAt: '2026-07-10 08:33:00' },
  { id: '6', name: 'Michael Chen', email: 'michael@awshop.io', role: 'user', status: 'active', createdAt: '2026-07-12 19:50:00' },
]

function nextId(): string {
  return String(Date.now())
}

function now(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ')
}

export const userRepository = {
  list({ page, pageSize, keyword }: UserListQuery): Paginated<User> {
    const kw = keyword?.toLowerCase() ?? ''
    const filtered = users.filter(u =>
      !kw
      || u.name.toLowerCase().includes(kw)
      || u.email.toLowerCase().includes(kw),
    )
    const start = (page - 1) * pageSize
    return {
      items: filtered.slice(start, start + pageSize),
      total: filtered.length,
      page,
      pageSize,
    }
  },

  findById(id: string): User | undefined {
    return users.find(u => u.id === id)
  },

  findByEmail(email: string): User | undefined {
    const normalized = email.toLowerCase()
    return users.find(u => u.email.toLowerCase() === normalized)
  },

  create(input: UserCreate): User {
    const user: User = { ...input, id: nextId(), createdAt: now() }
    users.unshift(user)
    return user
  },

  update(id: string, input: UserUpdate): User | undefined {
    const index = users.findIndex(u => u.id === id)
    if (index === -1) {
      return undefined
    }
    // 部分更新：input 覆盖对应字段，其余保持不变
    users[index] = { ...users[index], ...input } as User
    return users[index]
  },

  remove(id: string): boolean {
    const index = users.findIndex(u => u.id === id)
    if (index === -1) {
      return false
    }
    users.splice(index, 1)
    return true
  },
}
