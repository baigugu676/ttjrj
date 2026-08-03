/**
 * 点位管理路由
 * GET 所有登录角色可访问；增删改仅管理员
 */
const express = require('express');
const pool = require('../config/db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

/**
 * GET /api/locations — 点位列表（所有角色可访问，需登录）
 */
router.get('/', auth, async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, name, area, device_type, sort_order, status, created_at
       FROM locations
       ORDER BY sort_order ASC, id ASC`
    );
    res.json({ code: 0, message: 'success', data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/locations — 添加点位（admin）
 * body: { name, area?, device_type?, sort_order?, status? }
 */
router.post('/', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const { name, area = '', device_type = '', sort_order = 0, status = 'active' } = req.body || {};

    // 参数校验
    if (!name || !String(name).trim()) {
      return res.json({ code: 1, message: '点位名称不能为空' });
    }
    if (!['active', 'inactive'].includes(status)) {
      return res.json({ code: 1, message: '状态不合法（active/inactive）' });
    }

    // 检查名称是否重复
    const [exists] = await pool.query(`SELECT id FROM locations WHERE name = ?`, [String(name).trim()]);
    if (exists.length > 0) {
      return res.json({ code: 1, message: '点位名称已存在' });
    }

    const [result] = await pool.query(
      `INSERT INTO locations (name, area, device_type, sort_order, status)
       VALUES (?, ?, ?, ?, ?)`,
      [String(name).trim(), area, device_type, Number(sort_order) || 0, status]
    );

    res.json({ code: 0, message: 'success', data: { id: result.insertId } });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/locations/:id — 编辑点位（admin）
 */
router.put('/:id', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '点位ID不合法' });
    }

    const { name, area, device_type, sort_order, status } = req.body || {};

    // 动态拼接更新字段
    const sets = [];
    const params = [];

    if (name !== undefined) {
      if (!String(name).trim()) {
        return res.json({ code: 1, message: '点位名称不能为空' });
      }
      sets.push('name = ?');
      params.push(String(name).trim());
    }
    if (area !== undefined) {
      sets.push('area = ?');
      params.push(area);
    }
    if (device_type !== undefined) {
      sets.push('device_type = ?');
      params.push(device_type);
    }
    if (sort_order !== undefined) {
      sets.push('sort_order = ?');
      params.push(Number(sort_order) || 0);
    }
    if (status !== undefined) {
      if (!['active', 'inactive'].includes(status)) {
        return res.json({ code: 1, message: '状态不合法（active/inactive）' });
      }
      sets.push('status = ?');
      params.push(status);
    }

    if (sets.length === 0) {
      return res.json({ code: 1, message: '没有需要更新的字段' });
    }

    params.push(id);
    const [result] = await pool.query(`UPDATE locations SET ${sets.join(', ')} WHERE id = ?`, params);

    if (result.affectedRows === 0) {
      return res.json({ code: 1, message: '点位不存在' });
    }

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/locations/:id — 删除点位（admin）
 */
router.delete('/:id', auth, requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '点位ID不合法' });
    }

    const [result] = await pool.query(`DELETE FROM locations WHERE id = ?`, [id]);
    if (result.affectedRows === 0) {
      return res.json({ code: 1, message: '点位不存在' });
    }

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    // 外键约束错误（点位下存在关联工单）
    if (err.code === 'ER_ROW_IS_REFERENCED_2' || err.code === 'ER_ROW_IS_REFERENCED') {
      return res.json({ code: 1, message: '该点位下存在关联工单，无法删除' });
    }
    next(err);
  }
});

module.exports = router;
