/**
 * 统计路由（全部接口仅管理员可访问）
 */
const express = require('express');
const pool = require('../config/db');
const { auth, requireRole } = require('../middleware/auth');

const router = express.Router();

// 所有统计接口需要：登录认证 + admin 角色
router.use(auth, requireRole('admin'));

/**
 * 将日期格式化为 YYYY-MM-DD
 * 兼容 mysql2 返回的 Date 对象和字符串
 */
function formatDate(date) {
  if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}/.test(date)) {
    return date.slice(0, 10);
  }
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * GET /api/statistics/overview — 核心概览统计
 * 今日新增、待处理数、本月完成数、平均维修时长
 */
router.get('/overview', async (req, res, next) => {
  try {
    // 今日新增工单数
    const [[todayNew]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM work_orders WHERE DATE(created_at) = CURDATE()`
    );

    // 待处理工单数（待审核 + 待接单）
    const [[pending]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM work_orders WHERE status IN ('pending_review', 'pending_repair')`
    );

    // 本月完成数（以验收通过时间为准）
    const [[monthDone]] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM acceptance_records
       WHERE result = 'pass' AND accepted_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')`
    );

    // 平均维修时长（分钟），基于维修记录的起止时间
    const [[avgDuration]] = await pool.query(
      `SELECT AVG(TIMESTAMPDIFF(MINUTE, start_time, end_time)) AS minutes
       FROM repair_records
       WHERE start_time IS NOT NULL AND end_time IS NOT NULL`
    );

    res.json({
      code: 0,
      message: 'success',
      data: {
        today_new: todayNew.cnt,                              // 今日新增
        pending_count: pending.cnt,                           // 待处理数
        month_completed: monthDone.cnt,                       // 本月完成数
        avg_repair_minutes: Math.round(Number(avgDuration.minutes || 0) * 10) / 10 // 平均维修时长（分钟）
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/statistics/status-distribution — 各状态工单数量
 */
router.get('/status-distribution', async (req, res, next) => {
  try {
    // 查询各状态数量
    const [rows] = await pool.query(
      `SELECT status, COUNT(*) AS count FROM work_orders GROUP BY status`
    );

    // 所有状态的中文映射，缺失状态补 0
    const statusMap = {
      pending_review: '待审核',
      pending_repair: '待接单',
      repairing: '维修中',
      pending_accept: '待验收',
      completed: '已完成',
      rejected: '已驳回',
      repair_returned: '返修退回'
    };

    const data = Object.entries(statusMap).map(([status, label]) => ({ status, label, count: 0 }));
    rows.forEach((r) => {
      const item = data.find((d) => d.status === r.status);
      if (item) item.count = r.count;
    });

    res.json({ code: 0, message: 'success', data });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/statistics/trend — 近30天每天新增/完成工单数量
 */
router.get('/trend', async (req, res, next) => {
  try {
    // 近30天新增工单
    const [newRows] = await pool.query(
      `SELECT DATE(created_at) AS d, COUNT(*) AS cnt
       FROM work_orders
       WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
       GROUP BY DATE(created_at)`
    );

    // 近30天完成工单（以验收通过时间为准）
    const [doneRows] = await pool.query(
      `SELECT DATE(accepted_at) AS d, COUNT(*) AS cnt
       FROM acceptance_records
       WHERE result = 'pass' AND accepted_at >= DATE_SUB(CURDATE(), INTERVAL 29 DAY)
       GROUP BY DATE(accepted_at)`
    );

    // 转成按日期索引的 Map
    const newMap = new Map(newRows.map((r) => [formatDate(r.d), r.cnt]));
    const doneMap = new Map(doneRows.map((r) => [formatDate(r.d), r.cnt]));

    // 生成近30天日期序列（从旧到新）
    const list = [];
    for (let i = 29; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = formatDate(d);
      list.push({
        date: key,
        new_count: newMap.get(key) || 0,        // 当天新增
        completed_count: doneMap.get(key) || 0  // 当天完成
      });
    }

    res.json({ code: 0, message: 'success', data: list });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/statistics/location-ranking — 点位故障次数排行（top 10）
 */
router.get('/location-ranking', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT l.id, l.name, l.area, l.device_type, COUNT(wo.id) AS fault_count
       FROM locations l
       LEFT JOIN work_orders wo ON wo.location_id = l.id
       GROUP BY l.id, l.name, l.area, l.device_type
       ORDER BY fault_count DESC, l.sort_order ASC
       LIMIT 10`
    );
    res.json({ code: 0, message: 'success', data: rows });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/statistics/repairer-workload — 维修人员工作量统计
 */
router.get('/repairer-workload', async (req, res, next) => {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.real_name, u.username, u.phone, u.status,
              COUNT(wo.id) AS total_assigned,                                  -- 总指派工单数
              SUM(CASE WHEN wo.status = 'completed' THEN 1 ELSE 0 END)  AS completed_count,  -- 已完成
              SUM(CASE WHEN wo.status = 'repairing' THEN 1 ELSE 0 END)  AS repairing_count,  -- 维修中
              SUM(CASE WHEN wo.status = 'pending_repair' THEN 1 ELSE 0 END) AS pending_count  -- 待接单
       FROM users u
       LEFT JOIN work_orders wo ON wo.assigned_repairer_id = u.id
       WHERE u.role = 'repairer'
       GROUP BY u.id, u.real_name, u.username, u.phone, u.status
       ORDER BY total_assigned DESC`
    );

    // SUM 无匹配行时返回 NULL，统一转为 0
    const data = rows.map((r) => ({
      ...r,
      total_assigned: Number(r.total_assigned) || 0,
      completed_count: Number(r.completed_count) || 0,
      repairing_count: Number(r.repairing_count) || 0,
      pending_count: Number(r.pending_count) || 0
    }));

    res.json({ code: 0, message: 'success', data });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
