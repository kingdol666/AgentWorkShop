# B0 止血批真机验收

- 时间:2026-10-29T11:07:17.236Z
- 结果:18/18

- PASS `BOOT` 隔离实例启动 + workshop ready
- PASS `S0.1` 首注册 = admin
- PASS `S0.2` 管理员建普通用户
- PASS `S0.3` 普通用户登录取得令牌
- PASS `S1.0` hybrid_twin 频道实例化(治理档位可调前置)
- PASS `S1.1` P0-1 非属主改治理档位 → 403
- PASS `S1.2` P0-1 非属主解绑生产模型 → 403
- PASS `S1.3` P0-1 档位未被越权请求改写
- PASS `S1.4` P0-1 属主/admin 改档位 → 放行且生效
- PASS `S1.5` P0-1 治理变更留审计(ops_log)
- PASS `S2.1` P0-2 伪造 XFF 不能换桶:22 次内触发 429
- PASS `S2.2` P0-2 限流阈值仍为 20/min(此前已用 2 次 → 第 19 次触顶)
- PASS `S3.1` P0-5 首次启动生成/采纳本机凭据文件
- PASS `S3.2` P0-5 本机凭据使数采链路真实连通(Timescale/对象存储在线)
- PASS `S3.3` P0-5 采纳来源 = 运行中容器(升级不断连)
- PASS `S4.1` compose 渲染:5432/9000/1883 只绑 127.0.0.1
- PASS `S4.2` compose 渲染:9001 无 publish(控制台默认关)
- PASS `S4.3` compose 渲染:三项凭据全部来自 env 文件(运行时注入)
