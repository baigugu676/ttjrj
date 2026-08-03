/**
 * JWT 认证中间件
 * 从 Authorization header 中提取 Bearer token 并验证
 */
const jwt = require('jsonwebtoken');

/**
 * 认证中间件：验证 token 并将用户信息挂载到 req.user
 * req.user = { id, role, real_name }
 */
function auth(req, res, next) {
  // 从请求头提取 token（格式: Bearer <token>）
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ code: 1, message: '未登录或 token 缺失' });
  }

  try {
    // 验证 token 签名与有效期
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    // 挂载当前用户信息到请求对象
    req.user = {
      id: payload.id,
      role: payload.role,
      real_name: payload.real_name
    };
    next();
  } catch (err) {
    return res.status(401).json({ code: 1, message: 'token 无效或已过期，请重新登录' });
  }
}

/**
 * 角色校验中间件工厂
 * 用法：requireRole('admin') 或 requireRole('admin', 'repairer')
 * 校验通过则继续，否则返回 403
 */
function requireRole(...roles) {
  return (req, res, next) => {
    // 必须先经过 auth 中间件
    if (!req.user) {
      return res.status(401).json({ code: 1, message: '未登录' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ code: 1, message: '无权限执行该操作' });
    }
    next();
  };
}

module.exports = { auth, requireRole };
