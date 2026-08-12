import { userRepository } from '../repositories/user.repository'
import type { UserListInput, UserListQuery } from '../types/user'
import type { UserCreate, UserUpdate } from '../schemas/user.schema'
import { AppError, ErrorCodes } from '../utils/errors'
import { useServerConfig } from '../utils/config'

/**
 * 用户业务逻辑层（Service）
 * 职责：领域规则、默认值解析（config 驱动）、跨仓库编排。
 * 不感知 HTTP 细节（h3），不直接触碰数据源 —— 与上下两层完全解耦。
 */
export const userService = {
  list(input: UserListInput) {
    // 分页默认值/上限由 config.yml -> api 驱动，服务端与前端配置一致
    const { api } = useServerConfig()
    const query: UserListQuery = {
      page: input.page,
      pageSize: Math.min(input.pageSize ?? api.pageSize, api.maxPageSize),
      keyword: input.keyword,
    }
    return userRepository.list(query)
  },

  getById(id: string) {
    const user = userRepository.findById(id)
    if (!user) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, '用户不存在')
    }
    return user
  },

  create(input: UserCreate) {
    if (userRepository.findByEmail(input.email)) {
      throw new AppError(409, ErrorCodes.CONFLICT, '邮箱已被注册')
    }
    return userRepository.create(input)
  },

  update(id: string, input: UserUpdate) {
    if (input.email) {
      const exists = userRepository.findByEmail(input.email)
      if (exists && exists.id !== id) {
        throw new AppError(409, ErrorCodes.CONFLICT, '邮箱已被占用')
      }
    }
    const user = userRepository.update(id, input)
    if (!user) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, '用户不存在')
    }
    return user
  },

  remove(id: string) {
    if (!userRepository.remove(id)) {
      throw new AppError(404, ErrorCodes.NOT_FOUND, '用户不存在')
    }
    return { id }
  },
}
