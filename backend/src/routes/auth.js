/**
 * 认证路由：登录 / 获取当前用户信息
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');

const router = express.Router();

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

    // 查询用户
    const [rows] = await pool.query(
      `SELECT id, username, password_hash, real_name, role, phone, avatar_url, status
       FROM users WHERE username = ?`,
      [username]
    );

    if (rows.length === 0) {
      return res.json({ code: 1, message: '用户名或密码错误' });
    }

    const user = rows[0];

    // 校验密码（bcrypt 比对）
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.json({ code: 1, message: '用户名或密码错误' });
    }

    // 校验账号状态
    if (user.status !== 'active') {
      return res.json({ code: 1, message: '账号已被禁用，请联系管理员' });
    }

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
 */
router.get('/me', auth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, openid, real_name, role, phone, avatar_url, status, created_at
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
