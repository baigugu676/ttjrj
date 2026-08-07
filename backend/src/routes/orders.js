/**
 * 工单路由（核心业务）
 *
 * 状态流转（见开发任务分工文档 §5）：
 *   pending_review ──审核通过──▶ pending_repair ──接单──▶ repairing
 *         │                            │                      │
 *         └──驳回──▶ rejected          │               提交维修记录
 *                                       │                      │
 *                                       │                      ▼
 *                                       │              pending_accept
 *                                       │                  │
 *                                       │         验收通过  │  退回维修
 *                                       │                  ▼       │
 *                                       │             completed    │
 *                                       │                          │
 *                                       │              repair_returned
 *                                       │                    │
 *                                       └── 重新审核 ◀───────┘（维修人员重新提交后）
 *
 * 校验规则：
 *   - 只有 pending_review 状态可以审核
 *   - 只有 pending_repair 状态可以接单
 *   - 只有 repairing / repair_returned（返修重新提交）可以提交维修记录
 *   - 只有 pending_accept 状态可以验收
 *
 * 权限：所有接口需登录；审核/验收/删除仅 admin；接单/提交维修仅 repairer
 */
const express = require('express');
const { body, validationResult } = require('express-validator');
const pool = require('../config/db');
const { auth, requireRole } = require('../middleware/auth');
const generateOrderNo = require('../utils/generateOrderNo');
const { notifyOrderStatusChange } = require('../utils/notify');

const router = express.Router();

// 工单状态中文映射（用于提示信息）
const statusMap = {
  pending_review: '待审核',
  pending_repair: '待接单',
  repairing: '维修中',
  pending_accept: '待验收',
  completed: '已完成',
  rejected: '已驳回',
  repair_returned: '返修退回'
};

// 工单状态合法值列表
const VALID_STATUS = Object.keys(statusMap);

// 所有工单接口都需要登录认证
router.use(auth);

/**
 * POST /api/orders — 创建工单（自动生成 order_no，状态 = pending_review）
 * body: { location_id, fault_description, repair_requirements? }
 */
router.post('/', [
  body('location_id').isInt({ min: 1 }).withMessage('请选择故障点位'),
  body('fault_description').trim().notEmpty().withMessage('故障描述不能为空')
    .isLength({ min: 5 }).withMessage('故障描述至少 5 个字'),
  body('repair_requirements').optional({ nullable: true }).trim()
], async (req, res, next) => {
  try {
    // 参数校验
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.json({ code: 1, message: errors.array()[0].msg });
    }

    const { location_id, fault_description, repair_requirements = null } = req.body;

    // 校验点位存在，同时取出点位名称用于通知
    const [locRows] = await pool.query(
      `SELECT id, name FROM locations WHERE id = ? AND status = 'active'`,
      [location_id]
    );
    if (locRows.length === 0) {
      return res.json({ code: 1, message: '故障点位不存在或已停用' });
    }

    // 生成工单号并写入（order_no 唯一，冲突时重试）
    let insertedOrderId = null;
    let orderNo = '';
    for (let i = 0; i < 3; i++) {
      orderNo = await generateOrderNo();
      try {
        const [result] = await pool.query(
          `INSERT INTO work_orders (order_no, reporter_id, location_id, fault_description, repair_requirements, status)
           VALUES (?, ?, ?, ?, ?, 'pending_review')`,
          [orderNo, req.user.id, location_id, fault_description, repair_requirements]
        );
        insertedOrderId = result.insertId;
        break;
      } catch (err) {
        // 仅处理唯一键冲突（工单号撞号），其他错误直接抛出
        if (err.code !== 'ER_DUP_ENTRY') throw err;
      }
    }

    if (insertedOrderId === null) {
      return res.json({ code: 1, message: '工单号生成失败，请重试' });
    }

    // 工单提交 → 通知管理员审核
    await notifyOrderStatusChange(insertedOrderId, 'submitted', orderNo, locRows[0].name);

    res.json({ code: 0, message: 'success', data: { id: insertedOrderId, order_no: orderNo } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders — 工单列表
 * 支持筛选：?status= &reporter_id= &assigned_repairer_id=
 * 分页：?page= &pageSize=
 * 数据权限：admin 看全部；user 只看自己提交的；repairer 只看指派给自己的
 */
router.get('/', async (req, res, next) => {
  try {
    // 分页参数
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20));

    // 动态拼接筛选条件
    const where = [];
    const params = [];

    // 按状态筛选（支持单个状态或逗号分隔的多个状态）
    if (req.query.status) {
      const statusList = Array.isArray(req.query.status)
        ? req.query.status
        : String(req.query.status).split(',').map((s) => s.trim()).filter(Boolean);
      const validStatuses = statusList.filter((s) => VALID_STATUS.includes(s));
      if (validStatuses.length === 1) {
        where.push('wo.status = ?');
        params.push(validStatuses[0]);
      } else if (validStatuses.length > 1) {
        where.push(`wo.status IN (${validStatuses.map(() => '?').join(', ')})`);
        params.push(...validStatuses);
      }
    }
    // 按报修人筛选
    if (req.query.reporter_id) {
      where.push('wo.reporter_id = ?');
      params.push(Number(req.query.reporter_id));
    }
    // 按指派维修人筛选
    if (req.query.assigned_repairer_id) {
      where.push('wo.assigned_repairer_id = ?');
      params.push(Number(req.query.assigned_repairer_id));
    }
    // 关键字搜索（工单号 / 点位名称 / 故障描述）
    if (req.query.keyword) {
      const kw = `%${String(req.query.keyword).trim()}%`;
      where.push('(wo.order_no LIKE ? OR l.name LIKE ? OR wo.fault_description LIKE ?)');
      params.push(kw, kw, kw);
    }

    // 角色数据权限限制
    if (req.user.role === 'user') {
      where.push('wo.reporter_id = ?');
      params.push(req.user.id);
    } else if (req.user.role === 'repairer') {
      where.push('wo.assigned_repairer_id = ?');
      params.push(req.user.id);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // 查询总条数
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM work_orders wo
       LEFT JOIN locations l ON wo.location_id = l.id
       ${whereSql}`, params
    );
    const total = countRows[0].total;

    // 查询列表（联表带出点位名称、报修人、维修人姓名）
    const [rows] = await pool.query(
      `SELECT wo.*,
              l.name AS location_name,
              l.area AS location_area,
              ur.real_name AS reporter_name,
              uw.real_name AS repairer_name
       FROM work_orders wo
       LEFT JOIN locations l  ON wo.location_id = l.id
       LEFT JOIN users ur     ON wo.reporter_id = ur.id
       LEFT JOIN users uw     ON wo.assigned_repairer_id = uw.id
       ${whereSql}
       ORDER BY wo.created_at DESC, wo.id DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, (page - 1) * pageSize]
    );

    res.json({ code: 0, message: 'success', data: { list: rows, total, page, pageSize } });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/orders/:id — 工单详情（含关联图片、维修记录、验收记录）
 */
router.get('/:id', async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '工单ID不合法' });
    }

    // 查询工单主信息（联表带出关联姓名）
    const [orders] = await pool.query(
      `SELECT wo.*,
              l.name AS location_name,
              l.area AS location_area,
              l.device_type AS location_device_type,
              ur.real_name AS reporter_name,
              uw.real_name AS repairer_name,
              ur2.real_name AS reviewer_name
       FROM work_orders wo
       LEFT JOIN locations l  ON wo.location_id = l.id
       LEFT JOIN users ur     ON wo.reporter_id = ur.id
       LEFT JOIN users uw     ON wo.assigned_repairer_id = uw.id
       LEFT JOIN users ur2    ON wo.reviewer_id = ur2.id
       WHERE wo.id = ?`,
      [id]
    );

    if (orders.length === 0) {
      return res.json({ code: 1, message: '工单不存在' });
    }
    const order = orders[0];

    // 数据权限校验
    if (req.user.role === 'user' && order.reporter_id !== req.user.id) {
      return res.json({ code: 1, message: '无权查看该工单' });
    }
    if (req.user.role === 'repairer' && order.assigned_repairer_id !== req.user.id) {
      return res.json({ code: 1, message: '无权查看该工单' });
    }

    // 关联图片
    const [images] = await pool.query(
      `SELECT * FROM order_images WHERE order_id = ? ORDER BY sort_order ASC, id ASC`,
      [id]
    );

    // 维修记录
    const [repairRecords] = await pool.query(
      `SELECT rr.*, u.real_name AS repairer_name
       FROM repair_records rr
       LEFT JOIN users u ON rr.repairer_id = u.id
       WHERE rr.order_id = ?
       ORDER BY rr.created_at ASC`,
      [id]
    );

    // 验收记录
    const [acceptanceRecords] = await pool.query(
      `SELECT ar.*, u.real_name AS reviewer_name
       FROM acceptance_records ar
       LEFT JOIN users u ON ar.reviewer_id = u.id
       WHERE ar.order_id = ?
       ORDER BY ar.accepted_at ASC`,
      [id]
    );

    res.json({
      code: 0,
      message: 'success',
      data: { ...order, images, repair_records: repairRecords, acceptance_records: acceptanceRecords }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/orders/:id/review — 管理员审核（仅 pending_review 可审核）
 * 通过：body { action: 'approve', assigned_repairer_id, review_comment? }
 *       状态 → pending_repair
 * 驳回：body { action: 'reject', reject_reason, review_comment? }
 *       状态 → rejected
 */
router.put('/:id/review', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '工单ID不合法' });
    }

    const { action, assigned_repairer_id, review_comment = null, reject_reason = null } = req.body || {};

    // 参数校验
    if (!['approve', 'reject'].includes(action)) {
      return res.json({ code: 1, message: '审核操作不合法（approve/reject）' });
    }
    if (action === 'approve' && !assigned_repairer_id) {
      return res.json({ code: 1, message: '审核通过时必须指派维修人员' });
    }
    if (action === 'reject' && !reject_reason) {
      return res.json({ code: 1, message: '驳回时必须填写驳回原因' });
    }

    // 查询工单（带点位名称，用于通知）
    const [orders] = await pool.query(
      `SELECT wo.*, l.name AS location_name
       FROM work_orders wo
       LEFT JOIN locations l ON wo.location_id = l.id
       WHERE wo.id = ? FOR UPDATE`,
      [id]
    );
    if (orders.length === 0) {
      return res.json({ code: 1, message: '工单不存在' });
    }
    const order = orders[0];

    // 状态流转校验：仅待审核状态可审核
    if (order.status !== 'pending_review') {
      return res.json({ code: 1, message: `当前状态为「${statusMap[order.status]}」，仅待审核工单可进行审核` });
    }

    if (action === 'approve') {
      // 校验指派的维修人员存在、角色正确且未被禁用
      const [repairers] = await pool.query(
        `SELECT id, real_name, status FROM users WHERE id = ? AND role = 'repairer'`,
        [assigned_repairer_id]
      );
      if (repairers.length === 0) {
        return res.json({ code: 1, message: '指定的维修人员不存在或角色不正确' });
      }
      if (repairers[0].status !== 'active') {
        return res.json({ code: 1, message: '指定的维修人员已被禁用' });
      }

      // 审核通过：状态 → pending_repair，记录审核人并指派维修人员
      await pool.query(
        `UPDATE work_orders
         SET status = 'pending_repair', assigned_repairer_id = ?, reviewer_id = ?, review_comment = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [assigned_repairer_id, req.user.id, review_comment, id]
      );

      // 审核通过 → 通知报修用户 + 维修人员
      await notifyOrderStatusChange(id, 'approved', order.order_no, order.location_name);
    } else {
      // 审核驳回：状态 → rejected
      await pool.query(
        `UPDATE work_orders
         SET status = 'rejected', reviewer_id = ?, review_comment = ?, reject_reason = ?, reviewed_at = NOW()
         WHERE id = ?`,
        [req.user.id, review_comment, reject_reason, id]
      );

      // 审核驳回 → 通知报修用户
      await notifyOrderStatusChange(id, 'rejected', order.order_no, order.location_name, reject_reason);
    }

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/orders/:id/accept-repair — 维修人员接单（仅 pending_repair 可接单）
 * 状态 → repairing
 */
router.put('/:id/accept-repair', requireRole('repairer'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '工单ID不合法' });
    }

    // 查询工单（带点位名称，用于通知）
    const [orders] = await pool.query(
      `SELECT wo.*, l.name AS location_name
       FROM work_orders wo
       LEFT JOIN locations l ON wo.location_id = l.id
       WHERE wo.id = ?`,
      [id]
    );
    if (orders.length === 0) {
      return res.json({ code: 1, message: '工单不存在' });
    }
    const order = orders[0];

    // 只能接指派给自己的工单
    if (order.assigned_repairer_id !== req.user.id) {
      return res.json({ code: 1, message: '该工单未指派给您，无法接单' });
    }
    // 状态流转校验：仅待接单状态可接单
    if (order.status !== 'pending_repair') {
      return res.json({ code: 1, message: `当前状态为「${statusMap[order.status]}」，仅待接单工单可以接单` });
    }

    await pool.query(`UPDATE work_orders SET status = 'repairing' WHERE id = ?`, [id]);

    // 维修人员接单 → 通知报修用户
    await notifyOrderStatusChange(id, 'accepted_repair', order.order_no, order.location_name);

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/orders/:id/repair — 维修人员提交维修记录
 * 支持两种流转：
 *   repairing        → pending_accept（正常维修完成，待验收）
 *   repair_returned  → pending_accept（返修后重新提交，待验收）
 * body(JSON): { start_time, end_time?, gps_latitude?, gps_longitude?,
 *               location_address?, fault_reason, repair_action }
 */
router.put('/:id/repair', requireRole('repairer'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '工单ID不合法' });
    }

    const {
      start_time,
      end_time,
      gps_latitude,
      gps_longitude,
      location_address = null,
      fault_reason = null,
      repair_action = null
    } = req.body || {};

    // 必填字段校验（end_time 未传时默认当前时间）
    if (!start_time) return res.json({ code: 1, message: '维修开始时间不能为空' });
    if (!fault_reason || !String(fault_reason).trim()) return res.json({ code: 1, message: '故障原因不能为空' });
    if (!repair_action || !String(repair_action).trim()) return res.json({ code: 1, message: '维修措施不能为空' });

    // 经纬度范围校验（可空）
    const lat = (gps_latitude === undefined || gps_latitude === null || gps_latitude === '')
      ? null : Number(gps_latitude);
    const lng = (gps_longitude === undefined || gps_longitude === null || gps_longitude === '')
      ? null : Number(gps_longitude);
    if (lat !== null && (Number.isNaN(lat) || lat < -90 || lat > 90)) {
      return res.json({ code: 1, message: '纬度不合法（范围 -90 ~ 90）' });
    }
    if (lng !== null && (Number.isNaN(lng) || lng < -180 || lng > 180)) {
      return res.json({ code: 1, message: '经度不合法（范围 -180 ~ 180）' });
    }

    // 查询工单（带点位名称，用于通知）
    const [orders] = await pool.query(
      `SELECT wo.*, l.name AS location_name
       FROM work_orders wo
       LEFT JOIN locations l ON wo.location_id = l.id
       WHERE wo.id = ?`,
      [id]
    );
    if (orders.length === 0) {
      return res.json({ code: 1, message: '工单不存在' });
    }
    const order = orders[0];

    // 仅指派的维修人员可操作
    if (order.assigned_repairer_id !== req.user.id) {
      return res.json({ code: 1, message: '该工单未指派给您，无法提交维修记录' });
    }
    // 状态流转校验：维修中可提交（→待验收）；返修退回可重新提交（→待验收）
    if (!['repairing', 'repair_returned'].includes(order.status)) {
      return res.json({
        code: 1,
        message: `当前状态为「${statusMap[order.status]}」，仅维修中或返修退回的工单可以提交维修记录`
      });
    }

    // 返修退回的工单重新提交后进入待验收流程
    const nextStatus = 'pending_accept';

    // 事务：更新工单状态 + 写入维修记录
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      await conn.query(`UPDATE work_orders SET status = ? WHERE id = ?`, [nextStatus, id]);
      await conn.query(
        `INSERT INTO repair_records (order_id, repairer_id, start_time, end_time, gps_latitude, gps_longitude, location_address, fault_reason, repair_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, req.user.id, start_time, end_time || new Date(), lat, lng, location_address, fault_reason, repair_action]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // 维修完成 → 通知管理员（返修重新提交时附加说明）
    const extra = order.status === 'repair_returned' ? '返修完成并重新提交' : '';
    await notifyOrderStatusChange(id, 'repair_done', order.order_no, order.location_name, extra);

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    next(err);
  }
});

/**
 * PUT /api/orders/:id/accept — 管理员验收（仅 pending_accept 可验收）
 * 通过：body { action: 'pass' }                状态 → completed
 * 退回：body { action: 'return', return_reason } 状态 → repair_returned
 */
router.put('/:id/accept', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '工单ID不合法' });
    }

    const { action, return_reason = null } = req.body || {};

    // 参数校验
    if (!['pass', 'return'].includes(action)) {
      return res.json({ code: 1, message: '验收操作不合法（pass/return）' });
    }
    if (action === 'return' && !return_reason) {
      return res.json({ code: 1, message: '退回时必须填写退回原因' });
    }

    // 查询工单（带点位名称，用于通知）
    const [orders] = await pool.query(
      `SELECT wo.*, l.name AS location_name
       FROM work_orders wo
       LEFT JOIN locations l ON wo.location_id = l.id
       WHERE wo.id = ?`,
      [id]
    );
    if (orders.length === 0) {
      return res.json({ code: 1, message: '工单不存在' });
    }
    const order = orders[0];

    // 状态流转校验：仅待验收状态可验收
    if (order.status !== 'pending_accept') {
      return res.json({ code: 1, message: `当前状态为「${statusMap[order.status]}」，仅待验收工单可以验收` });
    }

    // 事务：更新工单状态 + 写入验收记录
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      if (action === 'pass') {
        await conn.query(`UPDATE work_orders SET status = 'completed' WHERE id = ?`, [id]);
      } else {
        await conn.query(`UPDATE work_orders SET status = 'repair_returned' WHERE id = ?`, [id]);
      }
      await conn.query(
        `INSERT INTO acceptance_records (order_id, reviewer_id, result, return_reason)
         VALUES (?, ?, ?, ?)`,
        [id, req.user.id, action, action === 'return' ? return_reason : null]
      );

      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }

    // 发送通知：验收通过 → 通知维修人员；验收退回 → 通知维修人员返修
    const notifyAction = action === 'pass' ? 'accepted' : 'returned';
    await notifyOrderStatusChange(id, notifyAction, order.order_no, order.location_name, return_reason);

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/orders/:id — 删除工单（admin）
 * 关联的图片、维修记录、验收记录、通知通过外键 ON DELETE CASCADE 自动清理
 */
router.delete('/:id', requireRole('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.json({ code: 1, message: '工单ID不合法' });
    }

    const [result] = await pool.query(`DELETE FROM work_orders WHERE id = ?`, [id]);
    if (result.affectedRows === 0) {
      return res.json({ code: 1, message: '工单不存在' });
    }

    res.json({ code: 0, message: 'success', data: null });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
