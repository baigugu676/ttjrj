/**
 * 数据统计云函数（微信云开发）- 仅管理员
 *
 * 入参（action）：
 *   overview          概览（今日新增/待处理/本月完成/平均维修时长）
 *   statusDistribution 各状态工单数量
 *   trend              近30天每天新增/完成数量
 *   locationRanking    点位故障次数排行（top 10）
 *   repairerWorkload   维修人员工作量
 *
 * 返回统一格式：{ code: 0, data, message: 'success' }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

function ok(data) {
  return { code: 0, message: 'success', data };
}

function fail(message, code = 1) {
  return { code, message };
}

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    return true;
  } catch (err) {
    const msg = (err && (err.message || err.errMsg || String(err))) || '';
    if (/already exists|已存在|ResourceExist|Collection already exists/i.test(msg)) return true;
    return false;
  }
}

async function getCurrentUser() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const res = await db.collection('users').where({ openid: OPENID }).limit(1).get();
  return res.data[0] || null;
}

// ---------------- 北京时间（UTC+8）日期工具 ----------------

// 北京今天的起止时刻（转换为 UTC Date 实例）
function todayRange() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const startMs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  return {
    start: new Date(startMs - 8 * 3600 * 1000),
    end: new Date(startMs - 8 * 3600 * 1000 + 86400000)
  };
}

// 北京本月 1 号 00:00
function monthStartDate() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1) - 8 * 3600 * 1000);
}

// N 天前（北京）00:00
function daysAgoStart(n) {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate() - n) - 8 * 3600 * 1000);
}

// 将任意时间值转成北京日期 YYYY-MM-DD
function bjDateKey(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const bj = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())}`;
}

function parseTime(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  const d = new Date(String(v).replace(/-/g, '/'));
  return isNaN(d.getTime()) ? null : d;
}

exports.main = async (event) => {
  try {
    // 仅确保核心集合存在
    const colOk = await ensureCollection('work_orders');
    if (!colOk) return fail('数据库集合初始化失败，请先运行 init 云函数');
    const user = await getCurrentUser();
    if (!user) return fail('未登录或 token 缺失');
    if (user.role !== 'admin') return fail('无权限执行该操作');

    const { action } = event || {};

    if (action === 'overview') {
      const range = todayRange();
      const todayNew = await db.collection('work_orders')
        .where({ created_at: _.gte(range.start).and(_.lt(range.end)) })
        .count();
      const pending = await db.collection('work_orders')
        .where({ status: _.in(['pending_review', 'pending_repair']) })
        .count();
      const monthDone = await db.collection('acceptance_records')
        .where({ result: 'pass', accepted_at: _.gte(monthStartDate()) })
        .count();

      // 平均维修时长（分钟），基于维修记录起止时间（字符串与 Date 混合兼容）
      const recs = await db.collection('repair_records').limit(1000).get();
      let totalMin = 0;
      let valid = 0;
      for (const r of recs.data) {
        const s = parseTime(r.start_time);
        const e = parseTime(r.end_time);
        if (s && e) {
          const diff = (e.getTime() - s.getTime()) / 60000;
          if (diff >= 0) {
            totalMin += diff;
            valid += 1;
          }
        }
      }
      const avg = valid ? Math.round((totalMin / valid) * 10) / 10 : 0;

      return ok({
        today_new: todayNew.total,
        pending_count: pending.total,
        month_completed: monthDone.total,
        avg_repair_minutes: avg
      });
    }

    if (action === 'statusDistribution') {
      const agg = await db.collection('work_orders')
        .aggregate()
        .group({ _id: '$status', count: $.sum(1) })
        .end();
      const statusMap = {
        pending_review: '待审核',
        pending_repair: '待接单',
        repairing: '维修中',
        pending_accept: '待验收',
        completed: '已完成',
        rejected: '已驳回',
        repair_returned: '返修退回'
      };
      const byStatus = {};
      (agg.list || []).forEach((g) => { byStatus[g._id] = g.count; });
      const data = Object.keys(statusMap).map((status) => ({
        status,
        label: statusMap[status],
        count: byStatus[status] || 0
      }));
      return ok(data);
    }

    if (action === 'trend') {
      const since = daysAgoStart(29);
      const newRes = await db.collection('work_orders')
        .where({ created_at: _.gte(since) })
        .field({ created_at: true })
        .limit(1000)
        .get();
      const doneRes = await db.collection('acceptance_records')
        .where({ result: 'pass', accepted_at: _.gte(since) })
        .field({ accepted_at: true })
        .limit(1000)
        .get();
      const newMap = {};
      const doneMap = {};
      newRes.data.forEach((r) => {
        const k = bjDateKey(r.created_at);
        newMap[k] = (newMap[k] || 0) + 1;
      });
      doneRes.data.forEach((r) => {
        const k = bjDateKey(r.accepted_at);
        doneMap[k] = (doneMap[k] || 0) + 1;
      });
      const list = [];
      for (let i = 29; i >= 0; i--) {
        const key = bjDateKey(daysAgoStart(i));
        list.push({
          date: key,
          new_count: newMap[key] || 0,
          completed_count: doneMap[key] || 0
        });
      }
      return ok(list);
    }

    if (action === 'locationRanking') {
      const ordersRes = await db.collection('work_orders')
        .field({ location_id: true })
        .limit(1000)
        .get();
      const locRes = await db.collection('locations').limit(1000).get();
      const counts = {};
      ordersRes.data.forEach((o) => {
        const id = o.location_id || '';
        counts[id] = (counts[id] || 0) + 1;
      });
      const data = locRes.data.map((l) => ({
        id: l._id,
        name: l.name,
        area: l.area || '',
        device_type: l.device_type || '',
        fault_count: counts[l._id] || 0
      })).sort((a, b) => b.fault_count - a.fault_count)
        .slice(0, 10);
      return ok(data);
    }

    if (action === 'repairerWorkload') {
      const repairers = await db.collection('users')
        .where({ role: 'repairer' })
        .limit(1000)
        .get();
      const ordersRes = await db.collection('work_orders')
        .field({ assigned_repairer_id: true, status: true })
        .limit(1000)
        .get();
      const data = repairers.data.map((u) => {
        const mine = ordersRes.data.filter((o) => o.assigned_repairer_id === u._id);
        return {
          id: u._id,
          real_name: u.real_name || '',
          username: u.username || '',
          phone: u.phone || '',
          status: u.status || 'active',
          total_assigned: mine.length,
          completed_count: mine.filter((o) => o.status === 'completed').length,
          repairing_count: mine.filter((o) => o.status === 'repairing').length,
          pending_count: mine.filter((o) => o.status === 'pending_repair').length
        };
      }).sort((a, b) => b.total_assigned - a.total_assigned);
      return ok(data);
    }

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
