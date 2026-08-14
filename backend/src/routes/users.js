/**
 * 用户管理路由（全部接口仅管理员可访问）
 */
const express = require('express');
const bcrypt = require('bcryptjs');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// 该路由下所有接口都需要：登录认证 + admin 角色
router.use(auth, requireRole('admin'));

/**
 * GET /api/users — 用户列表，支持 ?role= 和 ?keyword= 筛选
 */
router.get('/', async (req, res, next) => {
  try {
    const { role, keyword: rawKeyword } = req.query;
    // 不下发 openid（微信身份标识仅服务端内部使用）
    let sql = `SELECT id, username, real_name, role, phone, avatar_url, status, created_at, updated_at
               FROM users WHERE 1=1`;
    const params = [];

    // 角色筛选
    if (role && ['admin', 'user', 'repairer'].includes(role)) {
      sql += ' AND role = ?';
      params.push(role);
    }
    const keyword = rawKeyword ? String(rawKeyword).trim() : '';
    if (keyword) {
      const pattern = `%${keyword}%`;
      sql += ' AND (username LIKE ? OR real_name LIKE ? OR phone LIKE ?)';
      params.push(pattern, pattern, pattern);
    }

    sql += ' ORDER BY id ASC';

    const [rows] = await pool.query(sql, params);
    res.json({ code: 0, message: 'success', data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/users — 创建用户
 * 必填：username、password；可选：real_name、role、phone、avatar_url
 */
router.post('/', [
  body('username').trim().notEmpty().withMessage('用户名不能为空')
    .isLength({ min: 3, max: 30 }).withMessage('用户名长度需在 3-30 之间')
    .matches(/^[a-zA-Z0-9_]+$/).withMessage('用户名只能包含字母、数字和下划线'),
  body('password').notEmpty().withMessage('密码不能为空')
    .isLength({ min: 6 }).withMessage('密码长度至少 6 位'),
  body('real_name').optional({ nullable: true }).trim().isLength({ max: 50 }).withMessage('姓名过长'),
  body('role').optional({ nullable: true }).isIn(['admin', 'user', 'repairer']).withMessage('角色不合法'),
  body('phone').optional({ nullable: true }).matches(/^1\d{10}$/).withMessage('手机号格式不正确')
], async (req, res, next) => {
  try {
    // 参数校验结果
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.json({ code: 1, message: errors.array()[0].msg });
    }

    const { username, password, real_name = '', role = 'user', phone = null, avatar_url = null } = req.body;

    // 检查用户名是否重复
    const [exists] = await pool.query(`SELECT id FROM users WHERE username = ?`, [username]);
    if (exists.length > 0) {
      return res.json({ code: 1, message: '用户名已存在' });
    }

    // 密码加密存储
    const hash = await bcrypt.hash(password, 10);

    const [result] = await pool.query(
      `INSERT INTO users (username, password_hash, real_name, role, phone, avatar_url)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [username, hash, real_name, role, phone, avatar_url]
    );

    res.json({ code: 0, message: 'success', data: { id: result.insertId } });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/users/:id — 编辑用户
 * 可更新：real_name、role、phone、avatar_url、password（可选）
 */
router.put('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '用户ID不合法' });
    }

    const { real_name, role, phone, avatar_url, password } = req.body || {};

    // 动态拼接更新字段
    const sets = [];
    const params = [];

    if (real_name !== undefined) {
      sets.push('real_name = ?');
      params.push(real_name);
    }
    if (role !== undefined) {
      if (!['admin', 'user', 'repairer'].includes(role)) {
        return res.json({ code: 1, message: '角色不合法' });
      }
      // 防呆：不能修改自己的角色；降级最后一名活跃管理员会导致系统无人管理
      if (id === req.user.id && role !== 'admin') {
        return res.json({ code: 1, message: '不能修改当前登录账号的角色' });
      }
      if (role !== 'admin') {
        const [targetRows] = await pool.query(`SELECT role FROM users WHERE id = ?`, [id]);
        if (targetRows.length > 0 && targetRows[0].role === 'admin') {
          const [adminRows] = await pool.query(
            `SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND status = 'active'`
          );
          if (adminRows[0].cnt <= 1) {
            return res.json({ code: 1, message: '系统至少保留一名活跃管理员' });
          }
        }
      }
      sets.push('role = ?');
      params.push(role);
    }
    if (phone !== undefined) {
      if (phone !== null && !/^1\d{10}$/.test(phone)) {
        return res.json({ code: 1, message: '手机号格式不正确' });
      }
      sets.push('phone = ?');
      params.push(phone);
    }
    if (avatar_url !== undefined) {
      sets.push('avatar_url = ?');
      params.push(avatar_url);
    }
    if (password) {
      if (password.length < 6) {
        return res.json({ code: 1, message: '密码长度至少 6 位' });
      }
      sets.push('password_hash = ?');
      params.push(await bcrypt.hash(password, 10));
    }

    if (sets.length === 0) {
      return res.json({ code: 1, message: '没有需要更新的字段' });
    }

    params.push(id);
    const [result] = await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

    if (result.affectedRows === 0) {
      return res.json({ code: 1, message: '用户不存在' });
    }

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/users/:id/status — 启用/禁用用户
 * body: { status: 'active' | 'disabled' }
 */
router.put('/:id/status', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '用户ID不合法' });
    }

    const { status } = req.body || {};
    if (!['active', 'disabled'].includes(status)) {
      return res.json({ code: 1, message: '状态不合法（active/disabled）' });
    }

    // 不允许禁用自己
    if (id === req.user.id && status === 'disabled') {
      return res.json({ code: 1, message: '不能禁用当前登录账号' });
    }

    // 不允许禁用最后一名活跃管理员
    if (status === 'disabled') {
      const [targetRows] = await pool.query(`SELECT role FROM users WHERE id = ?`, [id]);
      if (targetRows.length > 0 && targetRows[0].role === 'admin') {
        const [adminRows] = await pool.query(
          `SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin' AND status = 'active'`
        );
        if (adminRows[0].cnt <= 1) {
          return res.json({ code: 1, message: '系统至少保留一名活跃管理员' });
        }
      }
    }

    const [result] = await pool.query(`UPDATE users SET status = ? WHERE id = ?`, [status, id]);
    if (result.affectedRows === 0) {
      return res.json({ code: 1, message: '用户不存在' });
    }

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/users/:id — 删除用户
 * 若该用户存在关联的工单等数据，外键约束会阻止删除
 */
router.delete('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '用户ID不合法' });
    }

    // 不允许删除自己
    if (id === req.user.id) {
      return res.json({ code: 1, message: '不能删除当前登录账号' });
    }

    // 不允许删除最后一名管理员（无论是否活跃）
    const [targetRows] = await pool.query(`SELECT role FROM users WHERE id = ?`, [id]);
    if (targetRows.length > 0 && targetRows[0].role === 'admin') {
      const [adminRows] = await pool.query(`SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'`);
      if (adminRows[0].cnt <= 1) {
        return res.json({ code: 1, message: '系统至少保留一名管理员' });
      }
    }

    const [result] = await pool.query(`DELETE FROM users WHERE id = ?`, [id]);
    if (result.affectedRows === 0) {
      return res.json({ code: 1, message: '用户不存在' });
    }

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    // 外键约束错误（用户存在关联工单/通知等数据，无法删除）
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      return res.json({ code: 1, message: '该用户存在关联的工单等数据，无法删除' });
    }
    next(err);
  }
});

module.exports = router;
