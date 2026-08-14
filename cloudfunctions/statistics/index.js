/**
 * 数据统计云函数（微信云开发）- 仅管理员
 * 身份：以微信 OPENID 为唯一可信身份，_token 仅作账号提示（必须与 OPENID 绑定一致才有效）。
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

// 账号被禁用的哨兵值：与「未登录」区分，返回更明确的中文提示
const DISABLED_USER = { __disabled: true };

/**
 * 获取当前登录用户。
 * 安全约束：微信 OPENID 是唯一可信身份。_token（裸用户 _id）仅作账号提示，
 * 必须与当前微信 OPENID 绑定的用户一致才生效，否则回落 OPENID 查询——防止
 * 客户端伪造他人 _id 提权。
 */
async function getCurrentUser(event) {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const token = event && event._token ? String(event._token) : '';
  if (token) {
    try {
      const byToken = await db.collection('users').doc(token).get();
      if (byToken.data) {
        const u = byToken.data;
        if (u.openid === OPENID) {
          return u.status === 'disabled' ? DISABLED_USER : u;
        }
      }
    } catch (e) {
      // ignore token miss and fallback to OPENID
    }
  }
  const res = await db.collection('users').where({ openid: OPENID }).limit(1).get();
  const u = res.data[0] || null;
  if (!u) return null;
  return u.status === 'disabled' ? DISABLED_USER : u;
}

/**
 * 分页拉全量（云数据库单次 get 上限 1000 条，超出需分页）
 */
async function fetchAll(baseQuery, pageSize = 1000, maxPages = 50) {
  const out = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await baseQuery.skip(page * pageSize).limit(pageSize).get();
    out.push(...res.data);
    if (res.data.length < pageSize) break;
  }
  return out;
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

/**
 * 时间解析：无时区的「YYYY-MM-DD HH:mm[:ss]」按北京时间解析（历史数据），
 * 其余（ISO 带时区等）交给 new Date。避免运行环境时区不同导致时长失真。
 */
function parseTime(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number') return new Date(v);
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+08:00`);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

exports.main = async (event) => {
  try {
    const user = await getCurrentUser(event);
    if (!user) return fail('未登录或 token 缺失');
    if (user === DISABLED_USER) return fail('账号已被禁用，请联系管理员');
    if (user.role !== 'admin') return fail('无权限执行该操作');

    const { action } = event || {};

    if (action === 'overview') {
      const range = todayRange();
      const [todayNew, pending, monthRows] = await Promise.all([
        db.collection('work_orders')
          .where({ created_at: _.gte(range.start).and(_.lt(range.end)) })
          .count(),
        // 待处理口径：管理员待办 = 待审核 + 待验收
        db.collection('work_orders')
          .where({ status: _.in(['pending_review', 'pending_accept']) })
          .count(),
        // 本月完成按工单去重：同月「退回→返修→再验收」只计 1 次
        fetchAll(db.collection('acceptance_records')
          .where({ result: 'pass', accepted_at: _.gte(monthStartDate()) })
          .field({ order_id: true }))
      ]);
      const monthDone = new Set(monthRows.map((r) => String(r.order_id)).filter(Boolean)).size;

      // 平均维修时长（分钟）：与 REST 版口径一致——
      // 仅统计最终验收通过的工单的最后一条维修记录，避免返修遗留时长拉低平均值
      const [passRows, recs] = await Promise.all([
        fetchAll(db.collection('acceptance_records').where({ result: 'pass' }).field({ order_id: true })),
        fetchAll(db.collection('repair_records').orderBy('created_at', 'asc'))
      ]);
      const passOrderIds = new Set(passRows.map((r) => String(r.order_id)).filter(Boolean));
      const latestByOrder = new Map();
      for (const r of recs) {
        const oid = String(r.order_id);
        if (!passOrderIds.has(oid)) continue;
        latestByOrder.set(oid, r); // 升序遍历，后写覆盖 → 每单取最后一条
      }
      let totalMin = 0;
      let valid = 0;
      for (const r of latestByOrder.values()) {
        const s = parseTime(r.start_time);
        const e = parseTime(r.end_time);
        if (s && e) {
          const diff = (e.getTime() - s.getTime()) / 60000;
          if (diff > 0) {
            totalMin += diff;
            valid += 1;
          }
        }
      }
      const avg = valid ? Math.round((totalMin / valid) * 10) / 10 : 0;

      return ok({
        today_new: todayNew.total,
        pending_count: pending.total,
        month_completed: monthDone,
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
        pending_repair: '待维修',
        repairing: '维修中',
        pending_accept: '待验收',
        completed: '已完成',
        rejected: '已驳回',
        repair_returned: '退回维修'
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
      // 分页拉全量（默认 get 只有 100 条，超出后趋势会漏数）
      const [newRows, doneRows] = await Promise.all([
        fetchAll(db.collection('work_orders').where({ created_at: _.gte(since) }).field({ created_at: true })),
        fetchAll(db.collection('acceptance_records').where({ result: 'pass', accepted_at: _.gte(since) }).field({ accepted_at: true }))
      ]);
      const newMap = {};
      const doneMap = {};
      newRows.forEach((r) => {
        const k = bjDateKey(r.created_at);
        newMap[k] = (newMap[k] || 0) + 1;
      });
      doneRows.forEach((r) => {
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
      const agg = await db.collection('work_orders')
        .aggregate()
        .group({ _id: '$location_id', fault_count: $.sum(1) })
        .sort({ fault_count: -1 })
        .limit(10)
        .end();
      const ids = (agg.list || []).map((item) => item._id).filter(Boolean);
      const locMap = {};
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        const locRes = await db.collection('locations').where({ _id: _.in(chunk) }).limit(500).get();
        locRes.data.forEach((l) => { locMap[l._id] = l; });
      }
      const data = (agg.list || []).map((item) => {
        const l = locMap[item._id] || {};
        return {
          id: item._id,
          name: l.name || '',
          area: l.area || '',
          device_type: l.device_type || '',
          fault_count: item.fault_count || 0
        };
      });
      return ok(data);
    }

    if (action === 'repairerWorkload') {
      const repairers = await fetchAll(db.collection('users').where({ role: 'repairer' }));
      const groupedQueries = await Promise.all([
        db.collection('work_orders').aggregate().group({ _id: '$assigned_repairer_id', total_assigned: $.sum(1) }).end(),
        db.collection('work_orders').aggregate().match({ status: 'completed' }).group({ _id: '$assigned_repairer_id', completed_count: $.sum(1) }).end(),
        db.collection('work_orders').aggregate().match({ status: 'repairing' }).group({ _id: '$assigned_repairer_id', repairing_count: $.sum(1) }).end(),
        // 待处理口径与维修人员首页一致：待接单 + 退回维修
        db.collection('work_orders').aggregate().match({ status: _.in(['pending_repair', 'repair_returned']) }).group({ _id: '$assigned_repairer_id', pending_count: $.sum(1) }).end()
      ]);
      const statsMap = {};
      const mergeStats = (rows, field) => {
        (rows || []).forEach((item) => {
          const key = item._id || '';
          if (!statsMap[key]) statsMap[key] = {};
          statsMap[key][field] = item[field] || 0;
        });
      };
      mergeStats(groupedQueries[0].list || [], 'total_assigned');
      mergeStats(groupedQueries[1].list || [], 'completed_count');
      mergeStats(groupedQueries[2].list || [], 'repairing_count');
      mergeStats(groupedQueries[3].list || [], 'pending_count');
      const data = repairers.map((u) => {
        const mine = statsMap[u._id] || {};
        return {
          id: u._id,
          real_name: u.real_name || '',
          username: u.username || '',
          phone: u.phone || '',
          status: u.status || 'active',
          total_assigned: mine.total_assigned || 0,
          completed_count: mine.completed_count || 0,
          repairing_count: mine.repairing_count || 0,
          pending_count: mine.pending_count || 0
        };
      }).sort((a, b) => b.total_assigned - a.total_assigned);
      return ok(data);
    }

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
