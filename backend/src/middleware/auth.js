/**
 * JWT 认证中间件
 * 从 Authorization header 中提取 Bearer token 并验证。
 * 验证通过后校验账号仍存在且未被禁用（带短缓存），再挂载 req.user。
 */
const jwt = require('jsonwebtoken');
const pool = require('../config/db');

// 用户状态缓存（TTL 30 秒）：禁用/删除/改角色后最长 30 秒内生效，避免每个请求都查库
const userStatusCache = new Map();
const STATUS_TTL_MS = 30 * 1000;

// 数据库短暂不可用时记录时间，5 秒内不再重复探测（fail-open 由业务查询兜底）
let dbDownUntil = 0;

/**
 * 认证中间件：验证 token 并校验账号状态，将用户信息挂载到 req.user
 * req.user = { id, role, real_name }
 *
 * 环境变量 AUTH_STATUS_CHECK=0 可关闭数据库状态校验（仅用于无数据库的单元测试环境）。
 */
async function auth(req, res, next) {
  // 从请求头提取 token（格式: Bearer <token>）
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';

  if (!token) {
    return res.status(401).json({ code: 1, message: '未登录或 token 缺失' });
  }

  let payload;
  try {
    // 验证 token 签名与有效期
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ code: 1, message: 'token 无效或已过期，请重新登录' });
  }

  // 数据库实时角色（状态校验关闭或数据库短暂不可用时为 null，回退 token 中的 role）
  let dbRole = null;

  // 校验账号存在且未被禁用（防止禁用后旧 token 继续使用）
  if (process.env.AUTH_STATUS_CHECK !== '0') {
    try {
      const cacheKey = `u${payload.id}`;
      const cached = userStatusCache.get(cacheKey);
      let exists = true;
      let active = true;
      if (cached && cached.exp > Date.now()) {
        exists = cached.exists;
        active = cached.active;
        dbRole = cached.role;
      } else if (dbDownUntil <= Date.now()) {
        try {
          // 同时回查 role：角色调整（降权/提权）后以数据库实时值为准，不受旧 token 中 role 影响
          const [rows] = await pool.query(`SELECT role, status FROM users WHERE id = ?`, [payload.id]);
          exists = rows.length > 0;
          active = exists && rows[0].status === 'active';
          dbRole = exists ? rows[0].role : null;
          userStatusCache.set(cacheKey, { exists, active, role: dbRole, exp: Date.now() + STATUS_TTL_MS });
          if (userStatusCache.size > 5000) userStatusCache.clear();
        } catch (dbErr) {
          // 数据库不可用：短暂放行，避免认证层把服务整体打挂（后续业务查询同样会失败）
          dbDownUntil = Date.now() + 5000;
        }
      }
      if (!exists) {
        return res.status(401).json({ code: 1, message: '账号不存在，请联系管理员' });
      }
      if (!active) {
        return res.status(401).json({ code: 1, message: '账号已被禁用，请联系管理员' });
      }
    } catch (err) {
      return next(err);
    }
  }

  // 挂载当前用户信息到请求对象（role 以数据库实时值为准，查不到时回退 token 中的 role）
  req.user = {
    id: payload.id,
    role: dbRole || payload.role,
    real_name: payload.real_name
  };
  next();
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
