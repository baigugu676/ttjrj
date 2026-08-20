/**
 * 认证路由：登录 / 获取当前用户信息
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// ---------------- 登录限速（内存版，防暴力破解） ----------------
// 同一 IP+用户名 15 分钟内失败达到 10 次后锁定 15 分钟；登录成功即清除记录
const loginAttempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 10;

function isLocked(ip, username) {
  const rec = loginAttempts.get(`${ip}|${String(username).trim().toLowerCase()}`);
  return !!(rec && rec.lockedUntil && Date.now() < rec.lockedUntil);
}

function recordLoginFail(ip, username) {
  const key = `${ip}|${String(username).trim().toLowerCase()}`;
  const rec = loginAttempts.get(key) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= MAX_FAILS) {
    rec.fails = 0;
    rec.lockedUntil = Date.now() + WINDOW_MS;
  }
  loginAttempts.set(key, rec);
  // 防止内存无界增长
  if (loginAttempts.size > 2000) {
    const now = Date.now();
    for (const [k, v] of loginAttempts) {
      if (!v.lockedUntil || v.lockedUntil < now) loginAttempts.delete(k);
    }
  }
}

function recordLoginSuccess(ip, username) {
  loginAttempts.delete(`${ip}|${String(username).trim().toLowerCase()}`);
}

/**
 * POST /api/auth/login — 用户名 + 密码登录
 * 成功返回 JWT token 和用户基本信息
 */
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    // 参数校验
    if (!username || !password) {
      return res.json({ code: 1, message: '用户名和密码不能为空' });
    }

    const ip = req.ip || req.connection.remoteAddress || 'unknown';

    // 限速检查
    if (isLocked(ip, username)) {
      return res.json({ code: 1, message: '尝试次数过多，请 15 分钟后再试' });
    }

    // 查询用户
    const [rows] = await pool.query(
      `SELECT id, username, password_hash, real_name, role, phone, avatar_url, repair_type, status
       FROM users WHERE username = ?`,
      [username]
    );

    if (rows.length === 0) {
      recordLoginFail(ip, username);
      return res.json({ code: 1, message: '用户名或密码错误' });
    }

    const user = rows[0];

    // 校验密码（bcrypt 比对）
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      recordLoginFail(ip, username);
      return res.json({ code: 1, message: '用户名或密码错误' });
    }

    // 校验账号状态
    if (user.status !== 'active') {
      return res.json({ code: 1, message: '账号已被禁用，请联系管理员' });
    }

    recordLoginSuccess(ip, username);

    // 签发 JWT（有效期 7 天）
    const token = jwt.sign(
      { id: user.id, role: user.role, real_name: user.real_name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    // 不返回密码哈希
    const { password_hash, ...safeUser } = user;

    res.json({
      code: 0,
      message: 'success',
      data: { token, user: safeUser }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/auth/me — 获取当前登录用户信息（需认证）
 * 不下发 openid（微信身份标识仅服务端内部使用）
 */
router.get('/me', auth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, real_name, role, phone, avatar_url, repair_type, status, created_at
       FROM users WHERE id = ?`,
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.json({ code: 1, message: '用户不存在' });
    }

    res.json({ code: 0, message: 'success', data: rows[0] });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
