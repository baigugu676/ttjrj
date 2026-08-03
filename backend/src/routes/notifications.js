/**
 * 通知路由（需登录，仅操作当前用户自己的通知）
 */
const express = require('express');
const pool = require('../config/db');
const { auth } = require('../middleware/auth');

const router = express.Router();

// 所有通知接口需要登录认证
router.use(auth);

/**
 * GET /api/notifications — 当前用户的通知列表
 * 支持 ?is_read=0/1 筛选，分页 ?page= &pageSize=
 */
router.get('/', async (req, res, next) => {
  try {
    // 分页参数
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));

    const where = ['user_id = ?'];
    const params = [req.user.id];

    // 已读状态筛选
    if (req.query.is_read !== undefined) {
      const isRead = Number(req.query.is_read);
      if (isRead === 0 || isRead === 1) {
        where.push('is_read = ?');
        params.push(isRead);
      }
    }

    const whereSql = `WHERE ${where.join(' AND ')}`;

    // 查询总条数
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM notifications ${whereSql}`, params);

    // 查询列表（联表带出工单号）
    const [rows] = await pool.query(
      `SELECT n.*, wo.order_no
       FROM notifications n
       LEFT JOIN work_orders wo ON n.order_id = wo.id
       ${whereSql}
       ORDER BY n.created_at DESC, n.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    res.json({ code: 0, message: 'success', data: { list: rows, total, page, pageSize } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/notifications/unread-count — 当前用户未读通知数量
 */
router.get('/unread-count', async (req, res, next) => {
  try {
    const [[{ cnt }]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM notifications WHERE user_id = ? AND is_read = 0`,
      [req.user.id]
    );
    res.json({ code: 0, message: 'success', data: { unread_count: cnt } });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/notifications/:id/read — 标记单条通知已读
 */
router.put('/:id/read', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '通知ID不合法' });
    }

    // 只能标记自己的通知
    const [result] = await pool.query(
      `UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?`,
      [id, req.user.id]
    );
    if (result.affectedRows === 0) {
      return res.json({ code: 1, message: '通知不存在' });
    }

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/notifications/read-all — 当前用户全部标记已读
 */
router.put('/read-all', async (req, res, next) => {
  try {
    const [result] = await pool.query(
      `UPDATE notifications SET is_read = 1 WHERE user_id = ? AND is_read = 0`,
      [req.user.id]
    );
    res.json({ code: 0, message: 'success', data: { updated: result.affectedRows } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
