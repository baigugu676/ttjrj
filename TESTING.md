# 测试流程

本项目采用分层测试，测试代码不依赖生产数据库或微信开发者工具：

1. **静态检查**：提交前检查 JavaScript 语法（`node --check` 全量扫描）和 `git diff --check`。
2. **单元测试**：测试可独立运行的工具函数（日期格式化、图片拆分、工单时间线）。
3. **API 冒烟/集成测试**：以临时 HTTP 端口启动 Express，验证健康检查、404、JWT 认证、参数校验和统一响应格式。数据库查询在参数校验前不会发生，因此无需 MySQL。认证中间件的数据库状态校验通过 `AUTH_STATUS_CHECK=0` 关闭（测试文件已设置），账号禁用/删除场景在联调环境验证。
4. **真实联调**：准备 `.env`（`DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`、`JWT_SECRET`），执行 `npm run init-db` 初始化数据库后，再用 Postman/微信开发者工具覆盖登录、工单状态流转、上传和通知。
5. **发布回归**：按角色（admin/user/repairer）执行核心流程，确认权限、状态流转、分页筛选和错误提示。

## 运行命令

```bash
cd backend
npm test
```

全量语法检查（后端 + 云函数 + 小程序）：

```bash
find backend/src backend/scripts cloudfunctions miniprogram -name "*.js" -not -path "*/node_modules/*" | xargs -I{} node --check "{}"
```

（小程序当前无独立工具函数测试目录，静态检查 + 开发者工具真机联调为主。）

## 可复用约定

- `backend/test/helpers.js` 提供临时 HTTP 服务、JWT 测试令牌和 JSON 请求方法，新 API 测试只需复用这三个函数。
- 测试用密钥只在测试文件设置，禁止复用生产 `JWT_SECRET`。
- API 测试优先验证响应状态、`code`、`message` 和关键业务字段；数据库相关场景在联调环境补充。
- 每个测试保持独立，不依赖执行顺序或持久化数据。

## 云函数部署注意

- 云函数与 REST 保持同一业务口径：今日完成 = 今日验收通过；待处理(维修员) = 待接单 + 退回维修；点位启用 = 非 inactive。
- 身份校验：云函数以微信 OPENID 为唯一可信身份，`_token` 必须与 OPENID 绑定一致才生效。
- 订阅消息：在 `miniprogram/utils/subscribe-config.js` 与 `cloudfunctions/orders/subscribe.js` 中配置模板 ID 后生效；模板 ID 留空时自动跳过。
