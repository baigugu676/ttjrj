/**
 * 点位管理云函数（微信云开发）
 * GET 列表与监控只读接口所有登录角色可访问；增删改仅管理员。
 *
 * 入参（action）：
 *   list                          点位列表（集合为空时自动填充默认点位）
 *   monitorOverview               监控状态概览统计
 *   monitorStatus { keyword?, status? }  启用监控列表（首次调用自动补种点位）
 *   monitorDetail { id }          单个监控详情与维修历史
 *   create  { name, area?, device_type?, sort_order?, status? }
 *   update  { id, name?, area?, device_type?, sort_order?, status? }
 *   delete  { id }
 *
 * 返回统一格式：{ code: 0, data, message: 'success' }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

function ok(data) {
  return { code: 0, message: 'success', data };
}

function fail(message, code = 1) {
  return { code, message };
}

// 宽松模式创建集合：已存在视为成功，创建失败不阻断（由后续操作报具体错误）
async function ensureCollection(name) {
  try {
    await db.createCollection(name);
    return true;
  } catch (err) {
    const msg = (err && (err.message || err.errMsg || String(err))) || '';
    return /already exists|已存在|ResourceExist|Collection already exists/i.test(msg);
  }
}

const OPEN_STATUSES = ['pending_review', 'pending_repair', 'repairing', 'pending_accept', 'repair_returned'];
const REPAIRING_STATUSES = ['repairing', 'pending_accept', 'repair_returned'];
const STATUS_TEXT = { normal: '正常', fault: '故障中', repairing: '维修中' };
const classify = (orders) => {
  const open = orders.filter((o) => OPEN_STATUSES.includes(o.status));
  if (open.some((o) => REPAIRING_STATUSES.includes(o.status))) return 'repairing';
  return open.length ? 'fault' : 'normal';
};

// 默认点位（与 init 云函数一致）：5 个示例点位 + 生成至 300 个
function defaultLocationList() {
  const presets = [
    { name: '3号楼道摄像头-01', area: '3号楼', device_type: '摄像头', sort_order: 1, status: 'active' },
    { name: '大门入口摄像头-03', area: '大门', device_type: '摄像头', sort_order: 2, status: 'active' },
    { name: '停车场摄像头-02', area: '停车场', device_type: '摄像头', sort_order: 3, status: 'active' },
    { name: '2号楼道摄像头-01', area: '2号楼', device_type: '摄像头', sort_order: 4, status: 'active' },
    { name: '围墙报警器-05', area: '围墙', device_type: '报警器', sort_order: 5, status: 'active' }
  ];
  const list = presets.slice();
  for (let i = 6; i <= 300; i += 1) {
    list.push({
      name: `监控点位-${String(i).padStart(3, '0')}`,
      area: `区域${((i - 1) % 10) + 1}`,
      device_type: '摄像头',
      sort_order: i,
      status: 'active'
    });
  }
  return list;
}

// 集合为空时自动填充默认点位，返回新增数量（已有数据时跳过）
async function seedDefaultLocations() {
  let total = 0;
  try {
    const countRes = await db.collection('locations').count();
    total = countRes.total || 0;
  } catch (err) {
    return 0;
  }
  if (total > 0) return 0;
  const list = defaultLocationList();
  for (let i = 0; i < list.length; i += 20) {
    await Promise.all(list.slice(i, i + 20).map((l) => db.collection('locations').add({
      data: { ...l, created_at: db.serverDate() }
    })));
  }
  return list.length;
}

async function monitorRows() {
  let docs = [];
  try {
    docs = await getAllLocations();
  } catch (err) {
    console.warn('[locations] 点位读取失败:', err);
    docs = [];
  }
  // 历史数据可能缺少 status 字段：仅剔除明确停用的点位，其余视为启用
  const locations = docs.filter((l) => l.status !== 'inactive');
  locations.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));
  let orders = [];
  try {
    const orderRes = await db.collection('work_orders').limit(1000).get();
    orders = orderRes.data || [];
  } catch (err) {
    console.warn('[locations] 工单读取失败:', err);
    orders = [];
  }
  const activeIds = new Set(locations.map((l) => String(l._id)));
  return { locations, orders: orders.filter((o) => activeIds.has(String(o.location_id))) };
}

async function getAllLocations() {
  const pageSize = 100;
  const locations = [];
  let skip = 0;

  try {
    while (true) {
      const res = await db.collection('locations')
        .orderBy('sort_order', 'asc')
        .orderBy('created_at', 'asc')
        .skip(skip)
        .limit(pageSize)
        .get();
      const rows = res.data || [];
      locations.push(...rows);
      if (rows.length < pageSize) return locations;
      skip += rows.length;
    }
  } catch (err) {
    // 复合索引缺失时回退为无排序分页读取，顺序由调用方在 JS 中排序
    console.warn('[locations] 排序分页读取失败，回退为无排序分页:', err);
    const plain = [];
    let plainSkip = 0;
    while (true) {
      const res = await db.collection('locations').skip(plainSkip).limit(pageSize).get();
      const rows = res.data || [];
      plain.push(...rows);
      if (rows.length < pageSize) return plain;
      plainSkip += rows.length;
    }
  }
}

function mapMonitor(location, orders) {
  const status = classify(orders);
  const open = orders.filter((o) => OPEN_STATUSES.includes(o.status));
  const dates = orders.map((o) => o.updated_at || o.created_at).filter(Boolean).map((d) => new Date(d).getTime()).filter(Number.isFinite);
  return { id: location._id, name: location.name, area: location.area || '', device_type: location.device_type || '', status,
    statusText: STATUS_TEXT[status], openOrderCount: open.length, totalOrderCount: orders.length,
    lastActionAt: dates.length ? new Date(Math.max(...dates)).toISOString() : null };
}

async function monitorDetail(id) {
  let location = null;
  try {
    const locRes = await db.collection('locations').doc(id).get();
    location = locRes.data;
  } catch (err) {
    return null;
  }
  if (!location) return null;
  let orders = [];
  try {
    const orderRes = await db.collection('work_orders').where({ location_id: id }).limit(1000).get();
    orders = orderRes.data || [];
  } catch (err) {
    orders = [];
  }
  const orderIds = orders.map((o) => o._id);
  const repairs = [];
  const accepts = [];
  for (const oid of orderIds) {
    try {
      const rr = await db.collection('repair_records').where({ order_id: oid }).limit(1000).get();
      repairs.push(...(rr.data || []));
    } catch (err) { /* 集合缺失时忽略 */ }
    try {
      const ar = await db.collection('acceptance_records').where({ order_id: oid }).limit(1000).get();
      accepts.push(...(ar.data || []));
    } catch (err) { /* 集合缺失时忽略 */ }
  }
  const actorIds = [...new Set([
    ...orders.flatMap((o) => [o.reporter_id, o.assigned_repairer_id, o.reviewer_id]),
    ...repairs.map((r) => r.repairer_id),
    ...accepts.map((a) => a.reviewer_id)
  ].filter(Boolean).map(String))];
  const userNames = new Map();
  if (actorIds.length) {
    try {
      const userRes = await db.collection('users').where({ _id: _.in(actorIds) }).limit(1000).get();
      (userRes.data || []).forEach((u) => userNames.set(String(u._id), u.real_name || u.username || ''));
    } catch (err) { /* 用户集合缺失时回退为原始姓名 */ }
  }
  const nameOf = (idValue, fallback) => fallback || userNames.get(String(idValue)) || '';
  const timeline = [];
  const actor = (idValue, name, role) => ({ actorId: idValue || null, actorName: name || '', actorRole: role });
  for (const o of orders) {
    timeline.push({ time: o.created_at, action: 'submitted', description: o.fault_description || '提交报修', orderId: o._id,
      ...actor(o.reporter_id, nameOf(o.reporter_id, o.reporter_name), 'user') });
    if (o.reviewed_at && o.reviewer_id) {
      const rejected = o.status === 'rejected' || o.reject_reason;
      timeline.push({ time: o.reviewed_at, action: rejected ? 'rejected' : 'approved', description: rejected ? (o.reject_reason || o.review_comment || '管理员驳回工单') : (o.review_comment || '管理员审核通过'), orderId: o._id,
        ...actor(o.reviewer_id, nameOf(o.reviewer_id, o.reviewer_name), 'admin') });
    }
    repairs.filter((r) => r.order_id === o._id).forEach((r) => {
      if (r.start_time) timeline.push({ time: r.start_time, action: 'accepted_repair', description: '维修人员接单，开始维修', orderId: o._id,
        ...actor(r.repairer_id, nameOf(r.repairer_id, r.repairer_name || o.repairer_name), 'repairer') });
      timeline.push({ time: r.created_at, action: 'repair_done', description: [r.fault_reason, r.repair_action].filter(Boolean).join('；') || '提交维修记录', orderId: o._id,
        ...actor(r.repairer_id, nameOf(r.repairer_id, r.repairer_name || o.repairer_name), 'repairer') });
    });
    accepts.filter((a) => a.order_id === o._id).forEach((a) => timeline.push({ time: a.accepted_at, action: a.result === 'pass' ? 'accepted' : 'returned', description: a.result === 'pass' ? '管理员验收通过' : (a.return_reason || '管理员退回维修'), orderId: o._id,
      ...actor(a.reviewer_id, nameOf(a.reviewer_id, a.reviewer_name), 'admin') }));
  }
  timeline.sort((a, b) => new Date(a.time) - new Date(b.time));
  const durations = repairs.map((r) => new Date(r.end_time || r.created_at) - new Date(r.start_time || r.created_at)).filter((d) => Number.isFinite(d) && d >= 0);
  const recent = repairs.map((r) => r.end_time || r.created_at).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;
  const status = classify(orders);
  return { location: { id: location._id, name: location.name, area: location.area || '', device_type: location.device_type || '', status: location.status },
    id: location._id, name: location.name, area: location.area || '', device_type: location.device_type || '', status, statusText: STATUS_TEXT[status],
    openOrderCount: orders.filter((o) => OPEN_STATUSES.includes(o.status)).length, totalOrderCount: orders.length, lastActionAt: orders.length ? (orders.map((o) => o.updated_at || o.created_at).filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null) : null,
    metrics: { totalOrders: orders.length, completedOrders: orders.filter((o) => o.status === 'completed').length, faultOrders: orders.filter((o) => OPEN_STATUSES.includes(o.status)).length, recentRepairAt: recent, averageRepairDuration: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length / 60000) : 0 },
    orders: orders.map((o) => ({ id: o._id, orderNo: o.order_no, order_no: o.order_no, status: o.status, reporterId: o.reporter_id, reporterName: nameOf(o.reporter_id, o.reporter_name), repairerId: o.assigned_repairer_id, repairerName: nameOf(o.assigned_repairer_id, o.repairer_name), createdAt: o.created_at, updatedAt: o.updated_at })), timeline };
}

async function getCurrentUser(event) {
  const token = event && event._token ? String(event._token) : '';
  if (token) {
    try {
      const byToken = await db.collection('users').doc(token).get();
      if (byToken.data) return byToken.data;
    } catch (e) {
      // ignore token miss and fallback to OPENID
    }
  }
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const res = await db.collection('users').where({ openid: OPENID }).limit(1).get();
  return res.data[0] || null;
}

exports.main = async (event) => {
  try {
    // 宽松模式创建依赖集合（已存在则跳过）
    await ensureCollection('locations');
    await ensureCollection('work_orders');
    const user = await getCurrentUser(event);
    if (!user) return fail('未登录或 token 缺失');

    const { action } = event || {};

    if (action === 'list') {
      let locations = await getAllLocations();

      // 首次使用：集合为空则自动填充默认点位
      if (!locations.length) {
        await seedDefaultLocations();
        locations = await getAllLocations();
      }
      locations.sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0));

      const keyword = event.keyword ? String(event.keyword).trim().toLowerCase() : '';
      const list = keyword
        ? locations.filter((l) => `${l.name || ''} ${l.area || ''} ${l.device_type || ''}`.toLowerCase().includes(keyword))
        : locations;
      return ok(list.map((l) => ({ ...l, id: l._id })));
    }

    if (action === 'monitorOverview' || action === 'monitorStatus') {
      // 集合为空时自动补种默认点位，保证监控表格首次打开即有数据
      await seedDefaultLocations();
      const { locations, orders } = await monitorRows();
      const grouped = new Map(locations.map((l) => [String(l._id), []]));
      orders.forEach((o) => { const bucket = grouped.get(String(o.location_id)); if (bucket) bucket.push(o); });
      const list = locations.map((l) => mapMonitor(l, grouped.get(String(l._id)) || []));
      if (action === 'monitorStatus') {
        const keyword = event.keyword ? String(event.keyword).trim().toLowerCase() : '';
        const filtered = list.filter((m) => (!keyword || `${m.name} ${m.area} ${m.device_type}`.toLowerCase().includes(keyword)) && (!event.status || m.status === event.status));
        const page = Math.max(1, Number(event.page) || 1);
        const pageSize = Math.min(50, Math.max(1, Number(event.pageSize) || 20));
        const start = (page - 1) * pageSize;
        return ok({
          list: filtered.slice(start, start + pageSize),
          total: filtered.length,
          page,
          pageSize
        });
      }
      const total = list.length;
      const normal = list.filter((m) => m.status === 'normal').length;
      const fault = list.filter((m) => m.status === 'fault').length;
      const repairing = list.filter((m) => m.status === 'repairing').length;
      return ok({ total, normal, fault, repairing, completedOrders: orders.filter((o) => o.status === 'completed').length,
        normalRate: total ? Math.round(normal * 10000 / total) / 100 : 0,
        faultRate: total ? Math.round((fault + repairing) * 10000 / total) / 100 : 0,
        segments: [{ key: 'normal', label: '正常', value: normal, color: '#16a34a' }, { key: 'fault', label: '故障中', value: fault, color: '#ef4444' }, { key: 'repairing', label: '维修中', value: repairing, color: '#f59e0b' }] });
    }

    if (action === 'monitorDetail') {
      if (!event.id) return fail('点位ID不合法');
      const detail = await monitorDetail(String(event.id));
      return detail ? ok(detail) : fail('点位不存在');
    }

    // 以下操作仅管理员
    if (user.role !== 'admin') return fail('无权限执行该操作');

    if (action === 'create') {
      const { name, area = '', device_type = '', sort_order = 0, status = 'active' } = event;
      const locName = name ? String(name).trim() : '';
      if (!locName) return fail('点位名称不能为空');
      if (!['active', 'inactive'].includes(status)) return fail('状态不合法（active/inactive）');
      const exists = await db.collection('locations').where({ name: locName }).limit(1).get();
      if (exists.data.length) return fail('点位名称已存在');
      const add = await db.collection('locations').add({
        data: {
          name: locName,
          area,
          device_type,
          sort_order: Number(sort_order) || 0,
          status,
          created_at: db.serverDate()
        }
      });
      return ok({ id: add._id });
    }

    if (action === 'update') {
      const { id } = event;
      const data = {};
      if (event.name !== undefined) {
        const n = String(event.name).trim();
        if (!n) return fail('点位名称不能为空');
        data.name = n;
      }
      if (event.area !== undefined) data.area = event.area;
      if (event.device_type !== undefined) data.device_type = event.device_type;
      if (event.sort_order !== undefined) data.sort_order = Number(event.sort_order) || 0;
      if (event.status !== undefined) {
        if (!['active', 'inactive'].includes(event.status)) return fail('状态不合法（active/inactive）');
        data.status = event.status;
      }
      if (!Object.keys(data).length) return fail('没有需要更新的字段');
      try {
        await db.collection('locations').doc(id).update({ data });
      } catch (e) {
        return fail('点位不存在');
      }
      return ok(null);
    }

    if (action === 'delete') {
      const { id } = event;
      const linked = await db.collection('work_orders').where({ location_id: id }).limit(1).get();
      if (linked.data.length) return fail('该点位下存在关联工单，无法删除');
      try {
        await db.collection('locations').doc(id).remove();
      } catch (e) {
        return fail('点位不存在');
      }
      return ok(null);
    }

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
