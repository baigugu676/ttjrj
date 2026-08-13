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

async function getCurrentUser(event) {
  const token = event && event._token ? String(event._token) : '';
  if (token) {
    try {
      const byToken = await db.collection('users').doc(token).get();
      if (byToken.data) return byToken.data;
    } catch (e) {
      // Token may be stale; fall back to the caller's OpenID.
    }
  }
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const res = await db.collection('users').where({ openid: OPENID }).limit(1).get();
  return res.data[0] || null;
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
  const [locationsRes, ordersRes] = await Promise.all([
    db.collection('locations').where({ status: 'active' }).field({ _id: true }).limit(1000).get(),
    db.collection('work_orders').where({ status: _.in(OPEN_STATUSES) }).field({ location_id: true, status: true }).limit(1000).get()
  ]);
  const activeIds = new Set((locationsRes.data || []).map((location) => String(location._id)));
  const states = new Map();
  (ordersRes.data || []).forEach((order) => {
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
  return {
    total,
    normal,
    fault,
    repairing,
    normalRate: total ? Math.round(normal * 10000 / total) / 100 : 0,
    faultRate: total ? Math.round((fault + repairing) * 10000 / total) / 100 : 0
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
  const range = todayRange();
  const todayCondition = _.and([assigned, { status: 'completed' }, { updated_at: _.gte(range.start).and(_.lt(range.end)) }]);
  const [counts, pool, repairing, todayCompleted] = await Promise.all([
    statusCounts(assigned),
    db.collection('work_orders').where(poolCondition).orderBy('created_at', 'desc').limit(3).get(),
    db.collection('work_orders').where(repairingCondition).orderBy('created_at', 'desc').limit(3).get(),
    db.collection('work_orders').where(todayCondition).count()
  ]);
  return {
    stats: {
      pendingAccept: (counts.pending_repair || 0) + (counts.repair_returned || 0),
      repairing: counts.repairing || 0,
      todayCompleted: todayCompleted.total || 0
    },
    poolOrders: (pool.data || []).map((order) => ({ ...order, id: order._id })),
    repairingOrders: (repairing.data || []).map((order) => ({ ...order, id: order._id }))
  };
}

async function adminDashboard() {
  const [counts, latest, monthCompleted, overview] = await Promise.all([
    statusCounts({}),
    db.collection('work_orders').orderBy('created_at', 'desc').limit(5).get(),
    db.collection('acceptance_records').where({ result: 'pass', accepted_at: _.gte(monthStartDate()) }).count(),
    monitorOverview()
  ]);
  return {
    stats: {
      pendingReview: counts.pending_review || 0,
      pendingRepair: counts.pending_repair || 0,
      pendingAccept: counts.pending_accept || 0,
      repairReturned: counts.repair_returned || 0,
      monthCompleted: monthCompleted.total || 0
    },
    latestOrders: (latest.data || []).map((order) => ({ ...order, id: order._id })),
    monitorOverview: overview
  };
}

exports.main = async (event) => {
  try {
    const user = await getCurrentUser(event);
    if (!user) return fail('未登录或 token 缺失');
    if (user.role === 'admin') return ok(await adminDashboard());
    if (user.role === 'repairer') return ok(await repairerDashboard(user));
    return ok(await userDashboard(user));
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
