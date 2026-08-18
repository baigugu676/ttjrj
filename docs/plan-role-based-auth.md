# 纯角色模式权限改造实施计划

## 目标

将权限判断统一为纯角色模式：以登录返回的用户 `_id` 作为 `_token`，通过 `_token` 查询当前用户，权限仅由用户的 `role` 决定；业务云函数不再使用微信 `OPENID` 作为身份识别或权限判断依据。

## 实施步骤

1. 统一改写以下六个云函数的 `getCurrentUser(event)`：
   - `cloudfunctions/orders/index.js`
   - `cloudfunctions/users/index.js`
   - `cloudfunctions/locations/index.js`
   - `cloudfunctions/dashboard/index.js`
   - `cloudfunctions/statistics/index.js`
   - `cloudfunctions/notifications/index.js`

   函数只读取 `event._token`，按用户 `_id` 查询 `users` 集合；无 token、查询不到用户或查询异常时返回 `null`，禁用用户返回既有 `DISABLED_USER` 哨兵。

2. 更新上述文件头部及认证函数中的过期注释，明确 `_token` 是唯一身份凭据，权限由 `role` 决定，不再使用 `openid` 判断权限。

3. 修改 `cloudfunctions/init/index.js`：
   - 首次部署且不存在用户时继续放行。
   - 已存在用户时读取 `event._token`，查询对应用户，并要求 `role === 'admin'` 且 `status === 'active'`。

4. 保持以下内容不变：
   - `cloudfunctions/login/index.js` 中 OPENID 的登录绑定逻辑。
   - `miniprogram/utils/api.js` 的 `_token` 自动注入逻辑。
   - 现有各处基于 `user.role` 的角色检查点。

## 验证

1. 检查六个目标文件不再出现 `getWXContext` 或 `OPENID`。
2. 对六个目标文件及 `cloudfunctions/init/index.js` 执行 `node --check` 语法校验。
3. 检查差异，确认未修改登录云函数、API 自动注入逻辑和既有角色检查点。

## 提交

创建本地 commit，不 push：

`refactor: 云函数权限彻底改为 _token + 角色判断，移除 OPENID 身份回落`
