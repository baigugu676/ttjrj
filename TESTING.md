# 测试流程

本项目采用分层测试，测试代码不依赖生产数据库或微信开发者工具：

1. **静态检查**：提交前检查 JavaScript 语法和 `git diff --check`。
2. **单元测试**：测试可独立运行的工具函数（日期格式化、图片拆分、工单时间线）。
3. **API 冒烟/集成测试**：以临时 HTTP 端口启动 Express，验证健康检查、404、JWT 认证、参数校验和统一响应格式。数据库查询在参数校验前不会发生，因此无需 MySQL。
4. **真实联调**：准备 `.env`（`DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`、`JWT_SECRET`），执行数据库初始化脚本后，再用 Postman/微信开发者工具覆盖登录、工单状态流转、上传和通知。
5. **发布回归**：按角色（admin/user/repairer）执行核心流程，确认权限、状态流转、分页筛选和错误提示。

## 运行命令

```bash
cd backend
npm test
```

小程序工具函数测试：

```bash
node --test "miniprogram/test/**/*.test.js"
```

单个文件可以直接传给 `node --test`。测试基于 Node 18+ 内置 `node:test` 和 `fetch`，不需要额外测试框架。

## 可复用约定

- `backend/test/helpers.js` 提供临时 HTTP 服务、JWT 测试令牌和 JSON 请求方法，新 API 测试只需复用这三个函数。
- 测试用密钥只在测试文件设置，禁止复用生产 `JWT_SECRET`。
- API 测试优先验证响应状态、`code`、`message` 和关键业务字段；数据库相关场景在联调环境补充。
- 每个测试保持独立，不依赖执行顺序或持久化数据。
