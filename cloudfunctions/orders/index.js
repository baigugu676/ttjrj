/**
 * 工单管理云函数（微信云开发）- 核心业务
 *
 * 状态流转：
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
 *                                       └── 重新提交维修 ───┘（维修人员重新提交后直接进入待验收）
 *
 * 权限：所有接口需登录；审核/验收/删除仅 admin；接单/提交维修仅 repairer。
 * 数据权限：admin 看全部；user 只看自己提交的；repairer 只看指派给自己的。
 * 身份：以微信 OPENID 为唯一可信身份，_token 仅作账号提示（必须与 OPENID 绑定一致才有效）。
 *
 * 入参（action）：
 *   list          { status?, reporter_id?, assigned_repairer_id?, keyword?, completed_today?, page?, pageSize? }
 *   create        { location_id, fault_description, repair_requirements? }
 *   detail        { id }
 *   review        { id, review_action: 'approve'|'reject', assigned_repairer_id?, review_comment?, reject_reason? }
 *   acceptRepair  { id }
 *   repair        { id, start_time, end_time?, gps_latitude?, gps_longitude?, location_address?, fault_reason, repair_action }
 *   accept        { id, accept_action: 'pass'|'return', return_reason? }
 *   delete        { id }
 *   addImage      { order_id, image_url, image_type? }  客户端上传云存储后写入 order_images
 *   dashboard     {}  按当前角色聚合首页数据
 *   exportCsv     { status?, keyword? }  admin 导出工单 CSV（保存到云存储后返回 fileID）
 *
 * 返回统一格式：{ code: 0, data, message: 'success' }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

const statusMap = {
  pending_review: '待审核',
  pending_repair: '待维修',
  repairing: '维修中',
  pending_accept: '待验收',
  completed: '已完成',
  rejected: '已驳回',
  repair_returned: '退回维修'
};

const OPEN_STATUSES = ['pending_review', 'pending_repair', 'repairing', 'pending_accept', 'repair_returned'];
const REPAIRING_STATUSES = ['repairing', 'pending_accept', 'repair_returned'];

// 账号被禁用的哨兵值：与「未登录」区分，返回更明确的中文提示
const DISABLED_USER = { __disabled: true };

function ok(data) {
  return { code: 0, message: 'success', data };
}

function fail(message, code = 1) {
  return { code, message };
}

/**
 * 获取当前登录用户。
 * 安全约束：微信 OPENID 是唯一可信身份。_token（裸用户 _id）仅作账号提示，
 * 必须与当前微信 OPENID 绑定的用户一致才生效，否则回落 OPENID 查询——防止
 * 客户端伪造他人 _id 提权（例如冒充 admin）。
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

async function getOrder(id) {
  try {
    const res = await db.collection('work_orders').doc(id).get();
    return res.data || null;
  } catch (e) {
    return null;
  }
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

function todayStart() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  return new Date(Date.UTC(
    beijing.getUTCFullYear(),
    beijing.getUTCMonth(),
    beijing.getUTCDate()
  ) - 8 * 3600 * 1000);
}

function monthStart() {
  const now = new Date();
  const beijing = new Date(now.getTime() + 8 * 3600 * 1000);
  return new Date(Date.UTC(
    beijing.getUTCFullYear(),
    beijing.getUTCMonth(),
    1
  ) - 8 * 3600 * 1000);
}

/**
 * 将客户端提交的北京时间字符串（YYYY-MM-DD HH:mm[:ss]）规范化为带时区的 ISO 字符串，
 * 避免与 end_time 的 ISO 兜底格式混用导致时长计算在不同运行环境时区下失真。
 * 其他格式（已是 ISO 等）原样返回。
 */
function normalizeBeijingTime(value) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return s;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+08:00`).toISOString();
}

/**
 * 按验收记录（今日验收通过且 result=pass）提取今日完成工单的 order_id 集合（分页拉全量）。
 * 与 completed_today 筛选、维修人员「今日完成」统计共用同一口径。
 */
async function getTodayPassedOrderIds() {
  const ids = new Set();
  const base = db.collection('acceptance_records')
    .where({ result: 'pass', accepted_at: _.gte(todayStart()) })
    .field({ order_id: true });
  const rows = await fetchAll(base);
  rows.forEach((r) => { if (r.order_id) ids.add(String(r.order_id)); });
  return [...ids];
}

function countByStatus(groups) {
  const counts = {};
  (groups || []).forEach((group) => {
    counts[group._id] = Number(group.count) || 0;
  });
  return counts;
}

function toOrderSummary(order) {
  return {
    id: order._id,
    order_no: order.order_no,
    location_name: order.location_name,
    fault_description: order.fault_description,
    status: order.status,
    created_at: order.created_at,
    updated_at: order.updated_at
  };
}

async function getMonitorOverviewSummary() {
  const emptySummary = () => ({
    total: 0, normal: 0, fault: 0, repairing: 0, completedOrders: 0, normalRate: 0, faultRate: 0,
    segments: [
      { key: 'normal', label: '正常', value: 0, color: '#16a34a' },
      { key: 'fault', label: '故障中', value: 0, color: '#ef4444' },
      { key: 'repairing', label: '维修中', value: 0, color: '#f59e0b' }
    ]
  });

  let locationStates;
  try {
    const [locationsRes, openOrders, completedLocs] = await Promise.all([
      fetchAll(db.collection('locations').field({ _id: true, status: true })),
      // 只拉未完成工单判断当前状态，避免全量工单的 limit 截断
      fetchAll(db.collection('work_orders').where({ status: _.in(OPEN_STATUSES) }).field({ location_id: true, status: true })),
      // 已完成工单的位置分布（用于按启用点位口径统计 completedOrders）
      fetchAll(db.collection('work_orders').where({ status: 'completed' }).field({ location_id: true }))
    ]);

    // 历史点位可能缺少 status 字段，仅剔除明确停用的点位，其余视为启用
    locationStates = new Map(
      locationsRes
        .filter((location) => location.status !== 'inactive')
        .map((location) => [String(location._id), 'normal'])
    );
    const activeLocationIds = new Set(locationStates.keys());

    openOrders.forEach((order) => {
      const locationId = String(order.location_id);
      if (!activeLocationIds.has(locationId)) return;
      if (REPAIRING_STATUSES.includes(order.status)) {
        locationStates.set(locationId, 'repairing');
      } else if (locationStates.get(locationId) === 'normal') {
        locationStates.set(locationId, 'fault');
      }
    });

    const total = locationStates.size;
    let normal = 0;
    let fault = 0;
    let repairing = 0;
    locationStates.forEach((status) => {
      if (status === 'repairing') repairing += 1;
      else if (status === 'fault') fault += 1;
      else normal += 1;
    });
    // 与 REST 口径一致：仅统计启用点位下的已完成工单
    const completedOrders = completedLocs.filter((o) => activeLocationIds.has(String(o.location_id))).length;
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
  } catch (err) {
    console.warn('[orders] 监控概览统计读取失败，返回空统计:', err);
    return emptySummary();
  }
}

async function getDashboard(user) {
  if (user.role === 'user') {
    const filter = { reporter_id: user._id };
    const [statusRes, recentRes] = await Promise.all([
      db.collection('work_orders').aggregate().match(filter).group({ _id: '$status', count: $.sum(1) }).end(),
      db.collection('work_orders').where(filter).field({
        order_no: true, location_name: true, fault_description: true, status: true, created_at: true, updated_at: true
      }).orderBy('created_at', 'desc').limit(3).get()
    ]);
    const counts = countByStatus(statusRes.list);
    return {
      stats: {
        pendingReview: counts.pending_review || 0,
        pendingRepair: counts.pending_repair || 0,
        repairing: counts.repairing || 0,
        completed: counts.completed || 0
      },
      recentOrders: (recentRes.data || []).map(toOrderSummary)
    };
  }

  if (user.role === 'repairer') {
    const assignedFilter = { assigned_repairer_id: user._id };
    const [statusRes, poolRes, repairingRes, todayPassedIds] = await Promise.all([
      db.collection('work_orders').aggregate().match(assignedFilter).group({ _id: '$status', count: $.sum(1) }).end(),
      db.collection('work_orders').where({
        assigned_repairer_id: user._id,
        status: _.in(['pending_repair', 'repair_returned'])
      }).field({ order_no: true, location_name: true, fault_description: true, status: true, created_at: true, updated_at: true })
        .orderBy('created_at', 'desc').limit(3).get(),
      db.collection('work_orders').where({ assigned_repairer_id: user._id, status: 'repairing' })
        .field({ order_no: true, location_name: true, fault_description: true, status: true, created_at: true, updated_at: true })
        .orderBy('created_at', 'desc').limit(3).get(),
      getTodayPassedOrderIds()
    ]);
    const counts = countByStatus(statusRes.list);

    // 今日完成：与 completed_today 筛选口径一致 —— 今日验收通过且指派给本人的工单数
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
      poolOrders: (poolRes.data || []).map(toOrderSummary),
      repairingOrders: (repairingRes.data || []).map(toOrderSummary)
    };
  }

  const monthPassedRes = await fetchAll(
    db.collection('acceptance_records').where({ result: 'pass', accepted_at: _.gte(monthStart()) }).field({ order_id: true })
  );
  const [statusRes, latestRes, monitorOverview] = await Promise.all([
    db.collection('work_orders').aggregate().group({ _id: '$status', count: $.sum(1) }).end(),
    db.collection('work_orders').field({
      order_no: true, location_name: true, fault_description: true, status: true, created_at: true, updated_at: true
    }).orderBy('created_at', 'desc').limit(5).get(),
    getMonitorOverviewSummary()
  ]);
  const counts = countByStatus(statusRes.list);
  // 本月完成按工单去重：同月内「退回→返修→再验收」只计 1 次
  const monthOrderIds = new Set(monthPassedRes.map((r) => String(r.order_id)).filter(Boolean));
  return {
    stats: {
      pendingReview: counts.pending_review || 0,
      pendingRepair: counts.pending_repair || 0,
      pendingAccept: counts.pending_accept || 0,
      repairReturned: counts.repair_returned || 0,
      monthCompleted: monthOrderIds.size
    },
    latestOrders: (latestRes.data || []).map(toOrderSummary),
    monitorOverview
  };
}

// 当前北京时间（UTC+8）的工单号前缀：WO20260801
function todayPrefix() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `WO${bj.getUTCFullYear()}${p(bj.getUTCMonth() + 1)}${p(bj.getUTCDate())}`;
}

// 生成工单号：WO + 年月日 + 4位自增序号（固定 4 位，避免位数不同导致字典序错乱）
async function generateOrderNo() {
  const prefix = todayPrefix();
  // 转义 regex 特殊字符，防止前缀中意外出现正则关键字
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = await db.collection('work_orders')
    .where({ order_no: db.RegExp({ regexp: '^' + escaped }) })
    .orderBy('order_no', 'desc')
    .limit(1)
    .get();
  let seq = 1;
  if (res.data.length) {
    // 解析尾部完整数字（兼容旧 3 位序号），避免 slice(-3) 在 1000+ 时回绕
    const m = String(res.data[0].order_no).match(/(\d+)$/);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  if (seq > 9999) seq = 9999; // 溢出保护
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

// ---------------- 通知 ----------------
async function getAdminIds() {
  const rows = await fetchAll(db.collection('users').where({ role: 'admin', status: 'active' }).field({ _id: true }));
  return rows.map((u) => u._id);
}

async function sendNotification(userId, orderId, orderNo, type, title, content) {
  if (!userId) return;
  await db.collection('notifications').add({
    data: {
      user_id: userId,
      order_id: orderId,
      order_no: orderNo,
      type,
      title,
      content,
      is_read: false,
      created_at: db.serverDate()
    }
  });
}

async function notifyOrderStatusChange(orderId, action, orderNo, locationName, extra = '') {
  const order = await getOrder(orderId);
  if (!order) return;
  const reporterId = order.reporter_id;
  const repairerId = order.assigned_repairer_id || '';

  switch (action) {
    case 'submitted': {
      for (const adminId of await getAdminIds()) {
        await sendNotification(adminId, orderId, orderNo, 'order_submitted', '新工单待审核',
          `收到来自「${locationName}」的故障报修工单 ${orderNo}，请及时审核。`);
        await sendSubscribeMessage(adminId, '新工单待审核', `收到来自「${locationName}」的故障报修工单 ${orderNo}`, 'pages/admin/orders/orders');
      }
      break;
    }
    case 'approved': {
      await sendNotification(reporterId, orderId, orderNo, 'order_approved', '工单审核通过',
        `您的工单 ${orderNo}（${locationName}）审核通过，已指派维修人员，请耐心等待维修。`);
      await sendSubscribeMessage(reporterId, '工单审核通过', `您的工单 ${orderNo}（${locationName}）审核通过，已指派维修人员`, 'pages/report/detail/detail?id=' + orderId);
      if (repairerId) {
        await sendNotification(repairerId, orderId, orderNo, 'order_approved', '新工单待接单',
          `管理员为您指派了工单 ${orderNo}（${locationName}），请及时接单处理。`);
        await sendSubscribeMessage(repairerId, '新工单待接单', `管理员为您指派了工单 ${orderNo}（${locationName}）`, 'pages/repair/mytasks/mytasks');
      }
      break;
    }
    case 'rejected': {
      await sendNotification(reporterId, orderId, orderNo, 'order_rejected', '工单审核驳回',
        `您的工单 ${orderNo}（${locationName}）被驳回${extra ? `，原因：${extra}` : ''}。`);
      await sendSubscribeMessage(reporterId, '工单审核驳回', `您的工单 ${orderNo}（${locationName}）被驳回${extra ? `，原因：${extra}` : ''}`, 'pages/report/detail/detail?id=' + orderId);
      break;
    }
    case 'accepted_repair': {
      await sendNotification(reporterId, orderId, orderNo, 'order_accepted_repair', '维修人员已接单',
        `您的工单 ${orderNo}（${locationName}）已被维修人员接单，正在维修中。`);
      await sendSubscribeMessage(reporterId, '维修人员已接单', `您的工单 ${orderNo}（${locationName}）已被维修人员接单，正在维修中`, 'pages/report/detail/detail?id=' + orderId);
      break;
    }
    case 'repair_done': {
      for (const adminId of await getAdminIds()) {
        await sendNotification(adminId, orderId, orderNo, 'order_repair_done', '维修完成待处理',
          `工单 ${orderNo}（${locationName}）已完成维修${extra ? `，${extra}` : ''}，请及时处理。`);
        await sendSubscribeMessage(adminId, '维修完成待验收', `工单 ${orderNo}（${locationName}）已完成维修，请及时验收`, 'pages/admin/orders/orders');
      }
      break;
    }
    case 'accepted': {
      if (repairerId) {
        await sendNotification(repairerId, orderId, orderNo, 'order_accepted', '验收通过',
          `您维修的工单 ${orderNo}（${locationName}）已验收通过。`);
        await sendSubscribeMessage(repairerId, '验收通过', `您维修的工单 ${orderNo}（${locationName}）已验收通过`, 'pages/repair/mytasks/mytasks');
      }
      break;
    }
    case 'returned': {
      if (repairerId) {
        await sendNotification(repairerId, orderId, orderNo, 'order_returned', '验收退回返修',
          `您维修的工单 ${orderNo}（${locationName}）验收未通过${extra ? `，原因：${extra}` : ''}，请返修处理。`);
        await sendSubscribeMessage(repairerId, '验收退回返修', `您维修的工单 ${orderNo}（${locationName}）验收未通过${extra ? `，原因：${extra}` : ''}`, 'pages/repair/mytasks/mytasks');
      }
      if (reporterId) {
        await sendNotification(reporterId, orderId, orderNo, 'order_returned', '工单验收退回',
          `您的工单 ${orderNo}（${locationName}）验收未通过${extra ? `，原因：${extra}` : ''}，维修人员将重新维修。`);
        await sendSubscribeMessage(reporterId, '工单验收退回', `您的工单 ${orderNo}（${locationName}）验收未通过，维修人员将重新维修`, 'pages/report/detail/detail?id=' + orderId);
      }
      break;
    }
    default:
      break;
  }
}

// 通知失败不应回滚已成功的业务（如 create 已写入工单）
async function safeNotify(orderId, action, orderNo, locationName, extra = '') {
  try {
    await notifyOrderStatusChange(orderId, action, orderNo, locationName, extra);
  } catch (err) {
    console.warn('[orders] 通知发送失败（不影响业务）:', action, err);
  }
}

// 发送订阅消息（微信服务通知）：模板未配置或用户未订阅时静默跳过
async function sendSubscribeMessage(recipient, title, content, pagePath) {
  try {
    await require('./subscribe')(recipient, title, content, pagePath);
  } catch (err) {
    console.warn('[orders] 订阅消息发送失败（不影响业务）:', err);
  }
}

exports.main = async (event) => {
  try {
    const user = await getCurrentUser(event);
    if (!user) return fail('未登录或 token 缺失');
    if (user === DISABLED_USER) return fail('账号已被禁用，请联系管理员');
    const { action } = event || {};

    if (action === 'dashboard') {
      return ok(await getDashboard(user));
    }

    // 工单列表
    if (action === 'list') {
      const page = Math.max(1, Number(event.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(event.pageSize) || 20));

      const conds = [];
      if (event.status) {
        const statusList = Array.isArray(event.status)
          ? event.status
          : String(event.status).split(',').map((s) => s.trim()).filter(Boolean);
        const validStatuses = statusList.filter((s) => statusMap[s]);
        if (validStatuses.length === 1) {
          conds.push({ status: validStatuses[0] });
        } else if (validStatuses.length > 1) {
          conds.push(_.or(validStatuses.map((s) => ({ status: s }))));
        }
      }
      if (user.role === 'admin') {
        if (event.reporter_id) conds.push({ reporter_id: String(event.reporter_id) });
        if (event.assigned_repairer_id) conds.push({ assigned_repairer_id: String(event.assigned_repairer_id) });
      }

      // 角色数据权限
      if (user.role === 'user') conds.push({ reporter_id: user._id });
      if (user.role === 'repairer') conds.push({ assigned_repairer_id: user._id });

      if (event.completed_today) {
        // 口径：今日验收通过（acceptance_records.result=pass 且 accepted_at 今日）且状态 completed
        const orderIds = await getTodayPassedOrderIds();
        if (!orderIds.length) {
          return ok({ list: [], total: 0, page, pageSize });
        }
        conds.push({ status: 'completed' });
        // _.in 单次元素不宜过多，分块后用 or 合并
        const chunks = [];
        for (let i = 0; i < orderIds.length; i += 500) chunks.push({ _id: _.in(orderIds.slice(i, i + 500)) });
        conds.push(chunks.length === 1 ? chunks[0] : _.or(chunks));
      }

      // 关键字搜索：工单号 / 点位名称 / 故障描述
      const kw = event.keyword ? String(event.keyword).trim() : '';
      if (kw) {
        const reg = db.RegExp({ regexp: kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
        conds.push(_.or([
          { order_no: reg },
          { location_name: reg },
          { fault_description: reg }
        ]));
      }

      const base = conds.length
        ? db.collection('work_orders').where(_.and(conds))
        : db.collection('work_orders');
      const totalRes = await base.count();
      const res = await base
        .orderBy('created_at', 'desc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get();

      return ok({
        list: res.data.map((o) => ({ ...o, id: o._id })),
        total: totalRes.total,
        page,
        pageSize
      });
    }

    // 创建工单
    if (action === 'create') {
      const { location_id, fault_description, repair_requirements = null } = event;
      if (!location_id) return fail('请选择故障点位');
      if (!fault_description || String(fault_description).trim().length < 5) {
        return fail('故障描述至少 5 个字');
      }
      let loc = null;
      try {
        loc = (await db.collection('locations').doc(location_id).get()).data;
      } catch (e) { /* 点位不存在 */ }
      if (!loc || loc.status !== 'active') return fail('故障点位不存在或已停用');

      // 工单号并发保护：插入后检查唯一性，冲突则删除重试
      let add = null;
      let orderNo = '';
      for (let attempt = 0; attempt < 3 && !add; attempt++) {
        orderNo = await generateOrderNo();
        const candidate = await db.collection('work_orders').add({
          data: {
            order_no: orderNo,
            reporter_id: user._id,
            reporter_name: user.real_name || user.username || '',
            location_id: loc._id,
            location_name: loc.name,
            location_area: loc.area || '',
            location_device_type: loc.device_type || '',
            fault_description: String(fault_description).trim(),
            repair_requirements,
            status: 'pending_review',
            assigned_repairer_id: '',
            assigned_repairer_name: '',
            reviewer_id: '',
            reviewer_name: '',
            review_comment: '',
            reject_reason: '',
            reviewed_at: null,
            created_at: db.serverDate(),
            updated_at: db.serverDate()
          }
        });
        const dupRes = await db.collection('work_orders').where({ order_no: orderNo }).count();
        if (dupRes.total <= 1) {
          add = candidate;
        } else {
          // 并发下与他人撞号：删除本次插入，重新生成
          await db.collection('work_orders').doc(candidate._id).remove().catch(() => {});
        }
      }
      if (!add) return fail('工单号生成冲突，请稍后重试');
      await safeNotify(add._id, 'submitted', orderNo, loc.name);
      return ok({ id: add._id, order_no: orderNo });
    }

    // 工单详情
    if (action === 'detail') {
      const order = await getOrder(event.id);
      if (!order) return fail('工单不存在');
      if (user.role === 'user' && order.reporter_id !== user._id) return fail('无权查看该工单');
      if (user.role === 'repairer' && order.assigned_repairer_id !== user._id) return fail('无权查看该工单');

      const [imagesRes, repairRes, acceptRes] = await Promise.all([
        db.collection('order_images').where({ order_id: order._id }).orderBy('sort_order', 'asc').limit(1000).get(),
        db.collection('repair_records').where({ order_id: order._id }).orderBy('created_at', 'asc').limit(1000).get(),
        db.collection('acceptance_records').where({ order_id: order._id }).orderBy('accepted_at', 'asc').limit(1000).get()
      ]);

      return ok({
        ...order,
        id: order._id,
        images: imagesRes.data.map((r) => ({ ...r, id: r._id })),
        repair_records: repairRes.data.map((r) => ({ ...r, id: r._id })),
        acceptance_records: acceptRes.data.map((r) => ({ ...r, id: r._id }))
      });
    }

    // 管理员审核
    if (action === 'review') {
      if (user.role !== 'admin') return fail('无权限执行该操作');
      const { review_action, assigned_repairer_id, review_comment = '', reject_reason = '' } = event;
      const act = review_action;
      if (!['approve', 'reject'].includes(act)) return fail('审核操作不合法（approve/reject）');
      const order = await getOrder(event.id);
      if (!order) return fail('工单不存在');
      if (order.status !== 'pending_review') {
        return fail(`当前状态为「${statusMap[order.status] || order.status}」，仅待审核工单可进行审核`);
      }

      if (act === 'approve') {
        if (!assigned_repairer_id) return fail('审核通过时必须指派维修人员');
        let repairer = null;
        try {
          repairer = (await db.collection('users').doc(assigned_repairer_id).get()).data;
        } catch (e) { /* 不存在 */ }
        if (!repairer || repairer.role !== 'repairer') return fail('指定的维修人员不存在或角色不正确');
        if (repairer.status !== 'active') return fail('指定的维修人员已被禁用');

        // 条件更新保证原子性：并发/重复审核时只有一次生效
        const updateRes = await db.collection('work_orders')
          .where({ _id: order._id, status: 'pending_review' })
          .update({
            data: {
              status: 'pending_repair',
              assigned_repairer_id: repairer._id,
              assigned_repairer_name: repairer.real_name || repairer.username || '',
              reviewer_id: user._id,
              reviewer_name: user.real_name || user.username || '',
              review_comment,
              reviewed_at: db.serverDate(),
              updated_at: db.serverDate()
            }
          });
        if (!updateRes || !updateRes.stats || updateRes.stats.updated !== 1) {
          return fail('工单状态已变化，请刷新后重试');
        }
        await safeNotify(order._id, 'approved', order.order_no, order.location_name);
      } else {
        if (!reject_reason) return fail('驳回时必须填写驳回原因');
        const updateRes = await db.collection('work_orders')
          .where({ _id: order._id, status: 'pending_review' })
          .update({
            data: {
              status: 'rejected',
              reviewer_id: user._id,
              reviewer_name: user.real_name || user.username || '',
              review_comment,
              reject_reason,
              reviewed_at: db.serverDate(),
              updated_at: db.serverDate()
            }
          });
        if (!updateRes || !updateRes.stats || updateRes.stats.updated !== 1) {
          return fail('工单状态已变化，请刷新后重试');
        }
        await safeNotify(order._id, 'rejected', order.order_no, order.location_name, reject_reason);
      }
      return ok(null);
    }

    // 维修人员接单
    if (action === 'acceptRepair') {
      if (user.role !== 'repairer') return fail('无权限执行该操作');
      const order = await getOrder(event.id);
      if (!order) return fail('工单不存在');
      if (order.assigned_repairer_id !== user._id) return fail('该工单未指派给您，无法接单');
      if (order.status !== 'pending_repair') {
        return fail(`当前状态为「${statusMap[order.status] || order.status}」，仅待维修工单可以接单`);
      }
      // 条件更新：防双击重复接单
      const updateRes = await db.collection('work_orders')
        .where({ _id: order._id, status: 'pending_repair', assigned_repairer_id: user._id })
        .update({ data: { status: 'repairing', updated_at: db.serverDate() } });
      if (!updateRes || !updateRes.stats || updateRes.stats.updated !== 1) {
        return fail('工单状态已变化，请刷新后重试');
      }
      await safeNotify(order._id, 'accepted_repair', order.order_no, order.location_name);
      return ok(null);
    }

    // 维修人员提交维修记录
    if (action === 'repair') {
      if (user.role !== 'repairer') return fail('无权限执行该操作');
      const {
        start_time,
        end_time,
        gps_latitude,
        gps_longitude,
        location_address = '',
        fault_reason,
        repair_action
      } = event;

      if (!start_time) return fail('维修开始时间不能为空');
      if (!fault_reason || !String(fault_reason).trim()) return fail('故障原因不能为空');
      if (!repair_action || !String(repair_action).trim()) return fail('维修措施不能为空');

      const lat = (gps_latitude === undefined || gps_latitude === null || gps_latitude === '')
        ? null : Number(gps_latitude);
      const lng = (gps_longitude === undefined || gps_longitude === null || gps_longitude === '')
        ? null : Number(gps_longitude);
      if (lat !== null && (Number.isNaN(lat) || lat < -90 || lat > 90)) return fail('纬度不合法（范围 -90 ~ 90）');
      if (lng !== null && (Number.isNaN(lng) || lng < -180 || lng > 180)) return fail('经度不合法（范围 -180 ~ 180）');

      const order = await getOrder(event.id);
      if (!order) return fail('工单不存在');
      if (order.assigned_repairer_id !== user._id) return fail('该工单未指派给您，无法提交维修记录');
      if (!['repairing', 'repair_returned'].includes(order.status)) {
        return fail(`当前状态为「${statusMap[order.status] || order.status}」，仅维修中或退回维修的工单可以提交维修记录`);
      }

      // 时间统一规范化为带时区 ISO（客户端提交的是北京时间字符串）
      const startVal = normalizeBeijingTime(start_time);
      const endVal = normalizeBeijingTime(end_time) || new Date().toISOString();
      const originalStatus = order.status;

      // 先条件更新状态（原子防重），再写维修记录；记录写失败则回滚状态
      const updateRes = await db.collection('work_orders')
        .where({ _id: order._id, status: _.in(['repairing', 'repair_returned']) })
        .update({ data: { status: 'pending_accept', updated_at: db.serverDate() } });
      if (!updateRes || !updateRes.stats || updateRes.stats.updated !== 1) {
        return fail('工单状态已变化，请刷新后重试');
      }
      try {
        await db.collection('repair_records').add({
          data: {
            order_id: order._id,
            repairer_id: user._id,
            repairer_name: user.real_name || user.username || '',
            start_time: startVal,
            end_time: endVal,
            gps_latitude: lat,
            gps_longitude: lng,
            location_address,
            fault_reason: String(fault_reason).trim(),
            repair_action: String(repair_action).trim(),
            created_at: db.serverDate()
          }
        });
      } catch (err) {
        // 回滚状态，避免出现「待验收但无维修记录」的不一致
        await db.collection('work_orders').doc(order._id)
          .update({ data: { status: originalStatus, updated_at: db.serverDate() } }).catch(() => {});
        throw err;
      }

      const extra = originalStatus === 'repair_returned' ? '返修完成并重新提交，待验收' : '';
      await safeNotify(order._id, 'repair_done', order.order_no, order.location_name, extra);
      return ok(null);
    }

    // 管理员验收
    if (action === 'accept') {
      if (user.role !== 'admin') return fail('无权限执行该操作');
      const { accept_action, return_reason = '' } = event;
      const act = accept_action;
      if (!['pass', 'return'].includes(act)) return fail('验收操作不合法（pass/return）');
      const order = await getOrder(event.id);
      if (!order) return fail('工单不存在');
      if (order.status !== 'pending_accept') {
        return fail(`当前状态为「${statusMap[order.status] || order.status}」，仅待验收工单可以验收`);
      }
      if (act === 'return' && !return_reason) return fail('退回时必须填写退回原因');

      const newStatus = act === 'pass' ? 'completed' : 'repair_returned';
      const updateRes = await db.collection('work_orders')
        .where({ _id: order._id, status: 'pending_accept' })
        .update({
          data: {
            status: newStatus,
            updated_at: db.serverDate(),
            completed_at: act === 'pass' ? db.serverDate() : null
          }
        });
      if (!updateRes || !updateRes.stats || updateRes.stats.updated !== 1) {
        return fail('工单状态已变化，请刷新后重试');
      }
      try {
        await db.collection('acceptance_records').add({
          data: {
            order_id: order._id,
            reviewer_id: user._id,
            reviewer_name: user.real_name || user.username || '',
            result: act,
            return_reason: act === 'return' ? return_reason : '',
            accepted_at: db.serverDate()
          }
        });
      } catch (err) {
        // 回滚状态，避免「已完成/退回但无验收记录」的不一致
        await db.collection('work_orders').doc(order._id)
          .update({ data: { status: 'pending_accept', updated_at: db.serverDate() } }).catch(() => {});
        throw err;
      }
      await safeNotify(order._id, act === 'pass' ? 'accepted' : 'returned',
        order.order_no, order.location_name, return_reason);
      return ok(null);
    }

    // 删除工单（含关联数据）
    if (action === 'delete') {
      if (user.role !== 'admin') return fail('无权限执行该操作');
      const order = await getOrder(event.id);
      if (!order) return fail('工单不存在');
      await db.collection('work_orders').doc(order._id).remove();
      // 按条件批量删除关联数据，避免逐条 remove 的串行开销与 100 条截断
      for (const c of ['order_images', 'repair_records', 'acceptance_records', 'notifications']) {
        await db.collection(c).where({ order_id: order._id }).remove()
          .catch((err) => console.warn('[orders] 删除关联数据失败:', c, err));
      }
      return ok(null);
    }

    // 图片关联（客户端上传云存储后记录到 order_images）
    if (action === 'addImage') {
      const { order_id, image_url, image_type = 'report' } = event;
      if (!order_id || !image_url) return fail('参数不完整');
      const order = await getOrder(order_id);
      if (!order) return fail('工单不存在');
      const validTypes = ['report', 'repair_before', 'repair_after'];
      const type = validTypes.includes(image_type) ? image_type : 'report';

      // 归属与角色校验：user 仅能给自己报修的工单传报修图；repairer 仅能给指派给自己的工单传维修前后图
      if (user.role === 'user') {
        if (order.reporter_id !== user._id) return fail('无权操作该工单');
        if (type !== 'report') return fail('报修用户仅可上传报修照片');
      } else if (user.role === 'repairer') {
        if (order.assigned_repairer_id !== user._id) return fail('无权操作该工单');
        if (type === 'report') return fail('维修人员仅可上传维修前后照片');
        if (['completed', 'rejected'].includes(order.status)) return fail('工单已结束，无法上传维修照片');
      }
      // admin 不受限（可补充证据照片）

      const add = await db.collection('order_images').add({
        data: {
          order_id,
          image_url,
          image_type: type,
          uploader_id: user._id,
          sort_order: 0,
          created_at: db.serverDate()
        }
      });
      return ok({ url: image_url, order_image_id: add._id });
    }

    // 导出工单 CSV（仅 admin）：生成后写入云存储，返回 fileID 供前端下载
    if (action === 'exportCsv') {
      if (user.role !== 'admin') return fail('无权限执行该操作');
      const csv = await buildOrdersCsv(event);
      const uploadRes = await cloud.uploadFile({
        cloudPath: `exports/orders-${Date.now()}.csv`,
        fileContent: Buffer.from('﻿' + csv, 'utf8') // BOM 便于 Excel 识别中文
      });
      return ok({ fileID: uploadRes.fileID, count: csv.split('\n').length - 2 });
    }

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};

// 拼接工单 CSV：复用 list 的筛选口径（status/keyword/completed_today），全量分页拉取
async function buildOrdersCsv(event) {
  const header = ['工单号', '点位名称', '区域', '设备类型', '故障描述', '报修人', '维修人员', '状态', '创建时间', '更新时间'];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.map(esc).join(',')];

  const conds = [];
  if (event.status && statusMap[event.status]) conds.push({ status: event.status });
  if (event.completed_today) {
    const orderIds = await getTodayPassedOrderIds();
    if (!orderIds.length) return lines.join('\n');
    conds.push({ status: 'completed' });
    const chunks = [];
    for (let i = 0; i < orderIds.length; i += 500) chunks.push({ _id: _.in(orderIds.slice(i, i + 500)) });
    conds.push(chunks.length === 1 ? chunks[0] : _.or(chunks));
  }
  const kw = event.keyword ? String(event.keyword).trim() : '';
  if (kw) {
    const reg = db.RegExp({ regexp: kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), options: 'i' });
    conds.push(_.or([{ order_no: reg }, { location_name: reg }, { fault_description: reg }]));
  }
  const base = conds.length ? db.collection('work_orders').where(_.and(conds)) : db.collection('work_orders');
  const rows = await fetchAll(base.orderBy('created_at', 'desc'));
  rows.forEach((o) => {
    lines.push([
      o.order_no, o.location_name, o.location_area, o.location_device_type,
      o.fault_description, o.reporter_name, o.assigned_repairer_name,
      statusMap[o.status] || o.status,
      fmtCsvTime(o.created_at), fmtCsvTime(o.updated_at)
    ].map(esc).join(','));
  });
  return lines.join('\n');
}

function fmtCsvTime(v) {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
