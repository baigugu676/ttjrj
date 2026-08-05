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
 *                                       └── 重新审核 ◀───────┘（维修人员重新提交后）
 *
 * 权限：所有接口需登录；审核/验收/删除仅 admin；接单/提交维修仅 repairer。
 * 数据权限：admin 看全部；user 只看自己提交的；repairer 只看指派给自己的。
 *
 * 入参（action）：
 *   list          { status?, reporter_id?, assigned_repairer_id?, keyword?, page?, pageSize? }
 *   create        { location_id, fault_description, repair_requirements? }
 *   detail        { id }
 *   review        { id, action: 'approve'|'reject', assigned_repairer_id?, review_comment?, reject_reason? }
 *   acceptRepair  { id }
 *   repair        { id, start_time, end_time?, gps_latitude?, gps_longitude?, location_address?, fault_reason, repair_action }
 *   accept        { id, action: 'pass'|'return', return_reason? }
 *   delete        { id }
 *   addImage      { order_id, image_url, image_type? }  客户端上传云存储后写入 order_images
 *
 * 返回统一格式：{ code: 0, data, message: 'success' }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const statusMap = {
  pending_review: '待审核',
  pending_repair: '待接单',
  repairing: '维修中',
  pending_accept: '待验收',
  completed: '已完成',
  rejected: '已驳回',
  repair_returned: '返修退回'
};

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

async function getOrder(id) {
  try {
    const res = await db.collection('work_orders').doc(id).get();
    return res.data || null;
  } catch (e) {
    return null;
  }
}

// 当前北京时间（UTC+8）的工单号前缀：WO20260801
function todayPrefix() {
  const now = new Date();
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `WO${bj.getUTCFullYear()}${p(bj.getUTCMonth() + 1)}${p(bj.getUTCDate())}`;
}

// 生成工单号：WO + 年月日 + 3位自增序号
async function generateOrderNo() {
  const prefix = todayPrefix();
  const res = await db.collection('work_orders')
    .where({ order_no: db.RegExp({ regexp: '^' + prefix }) })
    .orderBy('order_no', 'desc')
    .limit(1)
    .get();
  let seq = 1;
  if (res.data.length) {
    const lastSeq = parseInt(res.data[0].order_no.slice(-3), 10);
    if (!Number.isNaN(lastSeq)) seq = lastSeq + 1;
  }
  return `${prefix}${String(seq).padStart(3, '0')}`;
}

// ---------------- 通知 ----------------
async function getAdminIds() {
  const res = await db.collection('users').where({ role: 'admin', status: 'active' }).limit(1000).get();
  return res.data.map((u) => u._id);
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
      }
      break;
    }
    case 'approved': {
      await sendNotification(reporterId, orderId, orderNo, 'order_approved', '工单审核通过',
        `您的工单 ${orderNo}（${locationName}）审核通过，已指派维修人员，请耐心等待维修。`);
      if (repairerId) {
        await sendNotification(repairerId, orderId, orderNo, 'order_approved', '新工单待接单',
          `管理员为您指派了工单 ${orderNo}（${locationName}），请及时接单处理。`);
      }
      break;
    }
    case 'rejected': {
      await sendNotification(reporterId, orderId, orderNo, 'order_rejected', '工单审核驳回',
        `您的工单 ${orderNo}（${locationName}）被驳回${extra ? `，原因：${extra}` : ''}。`);
      break;
    }
    case 'accepted_repair': {
      await sendNotification(reporterId, orderId, orderNo, 'order_accepted_repair', '维修人员已接单',
        `您的工单 ${orderNo}（${locationName}）已被维修人员接单，正在维修中。`);
      break;
    }
    case 'repair_done': {
      for (const adminId of await getAdminIds()) {
        await sendNotification(adminId, orderId, orderNo, 'order_repair_done', '维修完成待处理',
          `工单 ${orderNo}（${locationName}）已完成维修${extra ? `，${extra}` : ''}，请及时处理。`);
      }
      break;
    }
    case 'accepted': {
      if (repairerId) {
        await sendNotification(repairerId, orderId, orderNo, 'order_accepted', '验收通过',
          `您维修的工单 ${orderNo}（${locationName}）已验收通过。`);
      }
      break;
    }
    case 'returned': {
      if (repairerId) {
        await sendNotification(repairerId, orderId, orderNo, 'order_returned', '验收退回返修',
          `您维修的工单 ${orderNo}（${locationName}）验收未通过${extra ? `，原因：${extra}` : ''}，请返修处理。`);
      }
      break;
    }
    default:
      break;
  }
}

exports.main = async (event) => {
  try {
    await ensureCollection('users');
    await ensureCollection('work_orders');
    await ensureCollection('locations');
    await ensureCollection('notifications');
    await ensureCollection('order_images');
    await ensureCollection('repair_records');
    await ensureCollection('acceptance_records');
    const user = await getCurrentUser();
    if (!user) return fail('未登录或 token 缺失');
    const { action } = event || {};

    // 工单列表
    if (action === 'list') {
      const page = Math.max(1, Number(event.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(event.pageSize) || 20));

      const conds = [];
      if (event.status && statusMap[event.status]) conds.push({ status: event.status });
      if (event.reporter_id) conds.push({ reporter_id: String(event.reporter_id) });
      if (event.assigned_repairer_id) conds.push({ assigned_repairer_id: String(event.assigned_repairer_id) });

      // 角色数据权限
      if (user.role === 'user') conds.push({ reporter_id: user._id });
      if (user.role === 'repairer') conds.push({ assigned_repairer_id: user._id });

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

      const orderNo = await generateOrderNo();
      const add = await db.collection('work_orders').add({
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
      await notifyOrderStatusChange(add._id, 'submitted', orderNo, loc.name);
      return ok({ id: add._id, order_no: orderNo });
    }

    // 工单详情
    if (action === 'detail') {
      const order = await getOrder(event.id);
      if (!order) return fail('工单不存在');
      if (user.role === 'user' && order.reporter_id !== user._id) return fail('无权查看该工单');
      if (user.role === 'repairer' && order.assigned_repairer_id !== user._id) return fail('无权查看该工单');

      const imagesRes = await db.collection('order_images')
        .where({ order_id: order._id })
        .orderBy('sort_order', 'asc')
        .limit(1000)
        .get();
      const repairRes = await db.collection('repair_records')
        .where({ order_id: order._id })
        .orderBy('created_at', 'asc')
        .limit(1000)
        .get();
      const acceptRes = await db.collection('acceptance_records')
        .where({ order_id: order._id })
        .orderBy('accepted_at', 'asc')
        .limit(1000)
        .get();

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
      const { action: act, assigned_repairer_id, review_comment = '', reject_reason = '' } = event;
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

        await db.collection('work_orders').doc(order._id).update({
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
        await notifyOrderStatusChange(order._id, 'approved', order.order_no, order.location_name);
      } else {
        if (!reject_reason) return fail('驳回时必须填写驳回原因');
        await db.collection('work_orders').doc(order._id).update({
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
        await notifyOrderStatusChange(order._id, 'rejected', order.order_no, order.location_name, reject_reason);
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
        return fail(`当前状态为「${statusMap[order.status] || order.status}」，仅待接单工单可以接单`);
      }
      await db.collection('work_orders').doc(order._id).update({
        data: { status: 'repairing', updated_at: db.serverDate() }
      });
      await notifyOrderStatusChange(order._id, 'accepted_repair', order.order_no, order.location_name);
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
        return fail(`当前状态为「${statusMap[order.status] || order.status}」，仅维修中或返修退回的工单可以提交维修记录`);
      }

      const nextStatus = order.status === 'repair_returned' ? 'pending_review' : 'pending_accept';
      const endVal = end_time || new Date();

      await db.collection('repair_records').add({
        data: {
          order_id: order._id,
          repairer_id: user._id,
          repairer_name: user.real_name || user.username || '',
          start_time,
          end_time: endVal,
          gps_latitude: lat,
          gps_longitude: lng,
          location_address,
          fault_reason: String(fault_reason).trim(),
          repair_action: String(repair_action).trim(),
          created_at: db.serverDate()
        }
      });
      await db.collection('work_orders').doc(order._id).update({
        data: { status: nextStatus, updated_at: db.serverDate() }
      });

      const extra = order.status === 'repair_returned' ? '返修完成并重新提交' : '';
      await notifyOrderStatusChange(order._id, 'repair_done', order.order_no, order.location_name, extra);
      return ok(null);
    }

    // 管理员验收
    if (action === 'accept') {
      if (user.role !== 'admin') return fail('无权限执行该操作');
      const { action: act, return_reason = '' } = event;
      if (!['pass', 'return'].includes(act)) return fail('验收操作不合法（pass/return）');
      const order = await getOrder(event.id);
      if (!order) return fail('工单不存在');
      if (order.status !== 'pending_accept') {
        return fail(`当前状态为「${statusMap[order.status] || order.status}」，仅待验收工单可以验收`);
      }
      if (act === 'return' && !return_reason) return fail('退回时必须填写退回原因');

      const newStatus = act === 'pass' ? 'completed' : 'repair_returned';
      await db.collection('work_orders').doc(order._id).update({
        data: { status: newStatus, updated_at: db.serverDate() }
      });
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
      await notifyOrderStatusChange(order._id, act === 'pass' ? 'accepted' : 'returned',
        order.order_no, order.location_name, return_reason);
      return ok(null);
    }

    // 删除工单（含关联数据）
    if (action === 'delete') {
      if (user.role !== 'admin') return fail('无权限执行该操作');
      const order = await getOrder(event.id);
      if (!order) return fail('工单不存在');
      await db.collection('work_orders').doc(order._id).remove();
      for (const c of ['order_images', 'repair_records', 'acceptance_records', 'notifications']) {
        const idsRes = await db.collection(c)
          .where({ order_id: order._id })
          .field({ _id: true })
          .limit(1000)
          .get();
        for (const r of idsRes.data) {
          await db.collection(c).doc(r._id).remove();
        }
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

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
