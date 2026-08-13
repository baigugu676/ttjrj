/**
 * 点位管理路由
 * GET 所有登录角色可访问；增删改仅管理员
 */
const express = require('express');
const pool = require('../config/db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

const OPEN_STATUSES = ['pending_review', 'pending_repair', 'repairing', 'pending_accept', 'repair_returned'];
const REPAIRING_STATUSES = ['repairing', 'pending_accept', 'repair_returned'];
const STATUS_TEXT = {
  normal: '正常',
  fault: '故障中',
  repairing: '维修中'
};

function classifyLocation(orderRows) {
  const open = orderRows.filter((o) => OPEN_STATUSES.includes(o.status));
  if (open.some((o) => REPAIRING_STATUSES.includes(o.status))) return 'repairing';
  if (open.length) return 'fault';
  return 'normal';
}

function toDateValue(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

async function loadMonitorData() {
  const [locations] = await pool.query(
    `SELECT id, name, area, device_type, sort_order, status, created_at FROM locations WHERE status = 'active' ORDER BY sort_order ASC, id ASC`
  );
  if (!locations.length) return { locations, orders: [] };
  const [orders] = await pool.query(
    `SELECT wo.id, wo.order_no, wo.location_id, wo.reporter_id, wo.assigned_repairer_id, wo.reviewer_id,
            wo.status, wo.fault_description, wo.review_comment, wo.reject_reason,
            wo.created_at, wo.updated_at, wo.reviewed_at,
            COALESCE(ur.real_name, ur.username) AS reporter_name,
            COALESCE(uw.real_name, uw.username) AS repairer_name,
            COALESCE(uv.real_name, uv.username) AS reviewer_name
       FROM work_orders wo
       LEFT JOIN users ur ON ur.id = wo.reporter_id
       LEFT JOIN users uw ON uw.id = wo.assigned_repairer_id
       LEFT JOIN users uv ON uv.id = wo.reviewer_id
      WHERE wo.location_id IN (${locations.map(() => '?').join(',')})
      ORDER BY wo.created_at ASC, wo.id ASC`,
    locations.map((l) => l.id)
  );
  return { locations, orders };
}

function mapMonitor(location, orders) {
  const status = classifyLocation(orders);
  const openOrders = orders.filter((o) => OPEN_STATUSES.includes(o.status));
  const actionDates = orders.map((o) => o.updated_at || o.created_at).filter(Boolean).map((d) => new Date(d).getTime()).filter(Number.isFinite);
  return {
    id: location.id,
    name: location.name,
    area: location.area,
    device_type: location.device_type,
    status,
    statusText: STATUS_TEXT[status],
    openOrderCount: openOrders.length,
    totalOrderCount: orders.length,
    lastActionAt: actionDates.length ? new Date(Math.max(...actionDates)).toISOString() : null
  };
}

function actor(id, name, role) {
  return { actorId: id || null, actorName: name || '', actorRole: role || '' };
}

async function buildTimeline(orders) {
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const marks = [];
  const [repairs] = await pool.query(
    `SELECT rr.order_id, rr.repairer_id, rr.start_time, rr.end_time, rr.fault_reason, rr.repair_action, rr.created_at,
            COALESCE(u.real_name, u.username) AS repairer_name
       FROM repair_records rr LEFT JOIN users u ON u.id = rr.repairer_id
      WHERE rr.order_id IN (${ids.map(() => '?').join(',')}) ORDER BY rr.created_at ASC`, ids
  );
  const [accepts] = await pool.query(
    `SELECT ar.order_id, ar.reviewer_id, ar.result, ar.return_reason, ar.accepted_at,
            COALESCE(u.real_name, u.username) AS reviewer_name
       FROM acceptance_records ar LEFT JOIN users u ON u.id = ar.reviewer_id
      WHERE ar.order_id IN (${ids.map(() => '?').join(',')}) ORDER BY ar.accepted_at ASC`, ids
  );
  for (const o of orders) {
    marks.push({ time: o.created_at, action: 'submitted', description: o.fault_description || '提交报修', orderId: o.id,
      ...actor(o.reporter_id, o.reporter_name, 'user') });
    if (o.reviewed_at && o.reviewer_id) {
      const rejected = o.status === 'rejected' || o.reject_reason;
      marks.push({ time: o.reviewed_at, action: rejected ? 'rejected' : 'approved',
        description: rejected ? (o.reject_reason || o.review_comment || '管理员驳回工单') : (o.review_comment || '管理员审核通过'), orderId: o.id,
        ...actor(o.reviewer_id, o.reviewer_name, 'admin') });
    }
    const firstRepair = repairs.filter((r) => r.order_id === o.id);
    for (const r of firstRepair) {
      if (r.start_time) marks.push({ time: r.start_time, action: 'accepted_repair', description: '维修人员接单，开始维修', orderId: o.id,
        ...actor(r.repairer_id, r.repairer_name || o.repairer_name, 'repairer') });
      marks.push({ time: r.created_at, action: 'repair_done', description: [r.fault_reason, r.repair_action].filter(Boolean).join('；') || '提交维修记录', orderId: o.id,
        ...actor(r.repairer_id, r.repairer_name || o.repairer_name, 'repairer') });
    }
    for (const a of accepts.filter((r) => r.order_id === o.id)) {
      marks.push({ time: a.accepted_at, action: a.result === 'pass' ? 'accepted' : 'returned',
        description: a.result === 'pass' ? '管理员验收通过' : (a.return_reason || '管理员退回维修'), orderId: o.id,
        ...actor(a.reviewer_id, a.reviewer_name, 'admin') });
    }
  }
  return marks.filter((m) => m.time).sort((a, b) => new Date(a.time) - new Date(b.time));
}

/** GET /api/locations/monitor-overview — all authenticated roles */
router.get('/monitor-overview', auth, async (req, res, next) => {
  try {
    const { locations, orders } = await loadMonitorData();
    const grouped = new Map(locations.map((l) => [l.id, []]));
    orders.forEach((o) => { if (grouped.has(o.location_id)) grouped.get(o.location_id).push(o); });
    const monitors = locations.map((l) => mapMonitor(l, grouped.get(l.id)));
    const total = monitors.length;
    const normal = monitors.filter((m) => m.status === 'normal').length;
    const fault = monitors.filter((m) => m.status === 'fault').length;
    const repairing = monitors.filter((m) => m.status === 'repairing').length;
    const completedOrders = orders.filter((o) => o.status === 'completed').length;
    res.json({ code: 0, message: 'success', data: {
      total, normal, fault, repairing, completedOrders,
      normalRate: total ? Math.round(normal * 10000 / total) / 100 : 0,
      faultRate: total ? Math.round((fault + repairing) * 10000 / total) / 100 : 0,
      segments: [
        { key: 'normal', label: '正常', value: normal, color: '#16a34a' },
        { key: 'fault', label: '故障中', value: fault, color: '#ef4444' },
        { key: 'repairing', label: '维修中', value: repairing, color: '#f59e0b' }
      ]
    }});
  } catch (err) { next(err); }
});

/** GET /api/locations/monitor-status — active monitor list */
router.get('/monitor-status', auth, async (req, res, next) => {
  try {
    const { locations, orders } = await loadMonitorData();
    const grouped = new Map(locations.map((l) => [l.id, []]));
    orders.forEach((o) => { if (grouped.has(o.location_id)) grouped.get(o.location_id).push(o); });
    let list = locations.map((l) => mapMonitor(l, grouped.get(l.id)));
    const keyword = req.query.keyword ? String(req.query.keyword).trim().toLowerCase() : '';
    if (keyword) list = list.filter((m) => `${m.name} ${m.area || ''} ${m.device_type || ''}`.toLowerCase().includes(keyword));
    if (req.query.status && ['normal', 'fault', 'repairing'].includes(String(req.query.status))) list = list.filter((m) => m.status === req.query.status);
    res.json({ code: 0, message: 'success', data: list });
  } catch (err) { next(err); }
});

/** GET /api/locations/:id/monitor-detail — monitor-scoped read-only history */
router.get('/:id/monitor-detail', auth, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.json({ code: 1, message: '点位ID不合法' });
    const [locations] = await pool.query(`SELECT id, name, area, device_type, status, created_at FROM locations WHERE id = ?`, [id]);
    if (!locations.length) return res.json({ code: 1, message: '点位不存在' });
    const [orders] = await pool.query(
      `SELECT wo.id, wo.order_no, wo.location_id, wo.reporter_id, wo.assigned_repairer_id, wo.reviewer_id, wo.status,
              wo.fault_description, wo.created_at, wo.updated_at, wo.reviewed_at,
              COALESCE(ur.real_name, ur.username) AS reporter_name,
              COALESCE(uw.real_name, uw.username) AS repairer_name,
              COALESCE(uv.real_name, uv.username) AS reviewer_name
         FROM work_orders wo LEFT JOIN users ur ON ur.id = wo.reporter_id
         LEFT JOIN users uw ON uw.id = wo.assigned_repairer_id LEFT JOIN users uv ON uv.id = wo.reviewer_id
        WHERE wo.location_id = ? ORDER BY wo.created_at DESC, wo.id DESC`, [id]
    );
    const monitor = mapMonitor(locations[0], orders);
    const [repairs] = orders.length ? await pool.query(
      `SELECT rr.order_id, rr.start_time, rr.end_time, rr.created_at FROM repair_records rr WHERE rr.order_id IN (${orders.map(() => '?').join(',')})`, orders.map((o) => o.id)
    ) : [[]];
    const completed = orders.filter((o) => o.status === 'completed').length;
    const open = orders.filter((o) => OPEN_STATUSES.includes(o.status)).length;
    const durations = repairs.map((r) => new Date(r.end_time || r.created_at) - new Date(r.start_time || r.created_at)).filter((d) => Number.isFinite(d) && d >= 0);
    const recent = repairs.map((r) => r.end_time || r.created_at).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
    const timeline = await buildTimeline(orders);
    res.json({ code: 0, message: 'success', data: {
      location: { id: locations[0].id, name: locations[0].name, area: locations[0].area, device_type: locations[0].device_type, status: locations[0].status },
      ...monitor,
      metrics: { totalOrders: orders.length, completedOrders: completed, faultOrders: open, recentRepairAt: recent ? toDateValue(recent) : null,
        averageRepairDuration: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60000) : 0 },
      orders: orders.map((o) => ({ id: o.id, orderNo: o.order_no, order_no: o.order_no, status: o.status, reporterId: o.reporter_id, reporterName: o.reporter_name || '', repairerId: o.assigned_repairer_id, repairerName: o.repairer_name || '', createdAt: toDateValue(o.created_at), updatedAt: toDateValue(o.updated_at) })),
      timeline
    }});
  } catch (err) { next(err); }
});

/**
 * GET /api/locations — 点位列表（所有角色可访问，需登录）
 */
router.get('/', auth, async (req, res, next) => {
  try {
    const keyword = req.query.keyword ? String(req.query.keyword).trim() : '';
    const where = [];
    const params = [];
    if (keyword) {
      const pattern = `%${keyword}%`;
      where.push('(name LIKE ? OR area LIKE ? OR device_type LIKE ?)');
      params.push(pattern, pattern, pattern);
    }
    const [rows] = await pool.query(
      `SELECT id, name, area, device_type, sort_order, status, created_at
       FROM locations${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
       ORDER BY sort_order ASC, id ASC`,
      params
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
