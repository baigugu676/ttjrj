/**
 * 首页聚合数据云函数（微信云开发）
 * 与 orders 云函数的 dashboard action 保持同一口径（今日完成=今日验收通过、点位启用=非 inactive）。
 * 身份：以微信 OPENID 为唯一可信身份，_token 仅作账号提示（必须与 OPENID 绑定一致才有效）。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

const OPEN_STATUSES = ['pending_review', 'pending_repair', 'repairing', 'pending_accept', 'repair_returned'];
const REPAIRING_STATUSES = ['repairing', 'pending_accept', 'repair_returned'];

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
      // Token may be stale; fall back to the caller's OpenID.
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

// 按验收记录（今日验收通过）提取今日完成工单的 order_id 集合，与 orders completed_today 口径一致
async function getTodayPassedOrderIds() {
  const ids = new Set();
  const rows = await fetchAll(db.collection('acceptance_records')
    .where({ result: 'pass', accepted_at: _.gte(todayRange().start) })
    .field({ order_id: true }));
  rows.forEach((r) => { if (r.order_id) ids.add(String(r.order_id)); });
  return [...ids];
}

function todayRange() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const startMs = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate());
  return {
    start: new Date(startMs - 8 * 3600 * 1000),
    end: new Date(startMs - 8 * 3600 * 1000 + 86400000)
  };
}

function monthStartDate() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  return new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), 1) - 8 * 3600 * 1000);
}

function countByStatus(rows) {
  const counts = {};
  (rows || []).forEach((row) => { counts[row._id] = row.count || 0; });
  return counts;
}

async function statusCounts(condition) {
  const agg = await db.collection('work_orders').aggregate()
    .match(condition)
    .group({ _id: '$status', count: $.sum(1) })
    .end();
  return countByStatus(agg.list);
}

async function monitorOverview() {
  const [locationsRes, openOrders, completedLocs] = await Promise.all([
    // 口径与 orders/locations 云函数一致：非 inactive 即启用（兼容历史缺 status 数据）
    fetchAll(db.collection('locations').field({ _id: true, status: true })),
    fetchAll(db.collection('work_orders').where({ status: _.in(OPEN_STATUSES) }).field({ location_id: true, status: true })),
    // 已完成工单的位置分布（用于按启用点位口径统计 completedOrders，与 REST 一致）
    fetchAll(db.collection('work_orders').where({ status: 'completed' }).field({ location_id: true }))
  ]);
  const activeIds = new Set(locationsRes.filter((location) => location.status !== 'inactive').map((location) => String(location._id)));
  const states = new Map();
  openOrders.forEach((order) => {
    const id = String(order.location_id);
    if (!activeIds.has(id)) return;
    const current = states.get(id) || 'normal';
    states.set(id, REPAIRING_STATUSES.includes(order.status) ? 'repairing' : (current === 'normal' ? 'fault' : current));
  });
  const total = activeIds.size;
  let normal = 0;
  let fault = 0;
  let repairing = 0;
  activeIds.forEach((id) => {
    const status = states.get(id) || 'normal';
    if (status === 'repairing') repairing += 1;
    else if (status === 'fault') fault += 1;
    else normal += 1;
  });
  const completedOrders = completedLocs.filter((o) => activeIds.has(String(o.location_id))).length;
  return {
    total,
    normal,
    fault,
    repairing,
    completedOrders,
    normalRate: total ? Math.round(normal * 10000 / total) / 100 : 0,
    faultRate: total ? Math.round((fault + repairing) * 10000 / total) / 100 : 0,
    segments: [
      { key: 'normal', label: '正常', value: normal, color: '#16a34a' },
      { key: 'fault', label: '故障中', value: fault, color: '#ef4444' },
      { key: 'repairing', label: '维修中', value: repairing, color: '#f59e0b' }
    ]
  };
}

async function userDashboard(user) {
  const condition = { reporter_id: user._id };
  const [counts, recent] = await Promise.all([
    statusCounts(condition),
    db.collection('work_orders').where(condition).orderBy('created_at', 'desc').limit(3).get()
  ]);
  return {
    stats: {
      pendingReview: counts.pending_review || 0,
      pendingRepair: counts.pending_repair || 0,
      repairing: counts.repairing || 0,
      completed: counts.completed || 0
    },
    recentOrders: (recent.data || []).map((order) => ({ ...order, id: order._id }))
  };
}

async function repairerDashboard(user) {
  const assigned = { assigned_repairer_id: user._id };
  const poolCondition = _.and([assigned, { status: _.in(['pending_repair', 'repair_returned']) }]);
  const repairingCondition = _.and([assigned, { status: 'repairing' }]);
  const [counts, pool, repairing, todayPassedIds] = await Promise.all([
    statusCounts(assigned),
    db.collection('work_orders').where(poolCondition).orderBy('created_at', 'desc').limit(3).get(),
    db.collection('work_orders').where(repairingCondition).orderBy('created_at', 'desc').limit(3).get(),
    getTodayPassedOrderIds()
  ]);
  // 今日完成口径：今日验收通过且指派给本人的工单数（与 orders completed_today 一致）
  let todayCompleted = 0;
  if (todayPassedIds.length) {
    for (let i = 0; i < todayPassedIds.length; i += 500) {
      const chunk = todayPassedIds.slice(i, i + 500);
      const chunkRes = await db.collection('work_orders')
        .where({ assigned_repairer_id: user._id, _id: _.in(chunk) })
        .field({ _id: true })
        .limit(500)
        .get();
      todayCompleted += chunkRes.data.length;
    }
  }
  return {
    stats: {
      pendingAccept: (counts.pending_repair || 0) + (counts.repair_returned || 0),
      repairing: counts.repairing || 0,
      todayCompleted
    },
    poolOrders: (pool.data || []).map((order) => ({ ...order, id: order._id })),
    repairingOrders: (repairing.data || []).map((order) => ({ ...order, id: order._id }))
  };
}

async function adminDashboard() {
  const monthRows = await fetchAll(db.collection('acceptance_records')
    .where({ result: 'pass', accepted_at: _.gte(monthStartDate()) })
    .field({ order_id: true }));
  const [counts, latest, overview] = await Promise.all([
    statusCounts({}),
    db.collection('work_orders').orderBy('created_at', 'desc').limit(5).get(),
    monitorOverview()
  ]);
  // 本月完成按工单去重：同月「退回→返修→再验收」只计 1 次
  const monthCompleted = new Set(monthRows.map((r) => String(r.order_id)).filter(Boolean)).size;
  return {
    stats: {
      pendingReview: counts.pending_review || 0,
      pendingRepair: counts.pending_repair || 0,
      pendingAccept: counts.pending_accept || 0,
      repairReturned: counts.repair_returned || 0,
      monthCompleted
    },
    latestOrders: (latest.data || []).map((order) => ({ ...order, id: order._id })),
    monitorOverview: overview
  };
}

exports.main = async (event) => {
  try {
    const user = await getCurrentUser(event);
    if (!user) return fail('未登录或 token 缺失');
    if (user === DISABLED_USER) return fail('账号已被禁用，请联系管理员');
    if (user.role === 'admin') return ok(await adminDashboard());
    if (user.role === 'repairer') return ok(await repairerDashboard(user));
    return ok(await userDashboard(user));
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
