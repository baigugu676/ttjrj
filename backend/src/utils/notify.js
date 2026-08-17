/**
 * 通知发送辅助函数
 * 工单状态变更时自动向 notifications 表插入通知记录
 *
 * 导出：
 *   notifyOrderStatusChange(order_id, action, order_no, location_name, extra?)
 *     - action: 'submitted'      工单提交        → 通知管理员
 *     - action: 'approved'       审核通过        → 通知报修用户 + 维修人员
 *     - action: 'rejected'       审核驳回        → 通知报修用户
 *     - action: 'accepted_repair' 维修接单       → 通知报修用户
 *     - action: 'repair_done'    维修完成        → 通知管理员
 *     - action: 'accepted'       验收通过        → 通知维修人员
 *     - action: 'returned'       验收退回返修    → 通知维修人员 + 报修用户
 */
const pool = require('../config/db');

/**
 * 查询所有启用状态的管理员ID
 */
async function getAdminIds() {
  const [rows] = await pool.query(
    `SELECT id FROM users WHERE role = 'admin' AND status = 'active'`
  );
  return rows.map((r) => r.id);
}

/**
 * 给单个用户发送通知
 */
async function sendNotification(userId, orderId, type, title, content) {
  if (!userId) return;
  await pool.query(
    `INSERT INTO notifications (user_id, order_id, type, title, content) VALUES (?, ?, ?, ?, ?)`,
    [userId, orderId, type, title, content]
  );
}

/**
 * 批量发送相同内容的通知（单条多值 INSERT，避免 N 个接收人 N 次往返）
 */
async function sendNotificationBatch(userIds, orderId, type, title, content) {
  const targets = userIds.filter(Boolean);
  if (!targets.length) return;
  const values = targets.map(() => '(?, ?, ?, ?, ?)');
  const params = targets.flatMap((uid) => [uid, orderId, type, title, content]);
  await pool.query(
    `INSERT INTO notifications (user_id, order_id, type, title, content) VALUES ${values.join(', ')}`,
    params
  );
}

/**
 * 工单状态变更通知（规范中约定的统一入口）
 * @param {number} orderId       工单ID
 * @param {string} action        动作（见上方说明）
 * @param {string} orderNo       工单号
 * @param {string} locationName  点位名称
 * @param {string} [extra]       附加信息（如驳回原因、退回原因），可空
 */
async function notifyOrderStatusChange(orderId, action, orderNo, locationName, extra = '') {
  // 查询工单的报修人与维修人
  const [orders] = await pool.query(
    `SELECT reporter_id, assigned_repairer_id FROM work_orders WHERE id = ?`,
    [orderId]
  );
  if (orders.length === 0) return;
  const reporterId = orders[0].reporter_id;
  const repairerId = orders[0].assigned_repairer_id;

  switch (action) {
    case 'submitted': {
      // 工单提交 → 通知所有管理员审核
      await sendNotificationBatch(await getAdminIds(), orderId, 'order_submitted', '新工单待审核',
        `收到来自「${locationName}」的故障报修工单 ${orderNo}，请及时审核。`);
      break;
    }
    case 'approved': {
      // 审核通过 → 通知报修用户 + 维修人员
      await sendNotification(reporterId, orderId, 'order_approved', '工单审核通过',
        `您的工单 ${orderNo}（${locationName}）审核通过，已指派维修人员，请耐心等待维修。`);
      if (repairerId) {
        await sendNotification(repairerId, orderId, 'order_approved', '新工单待接单',
          `管理员为您指派了工单 ${orderNo}（${locationName}），请及时接单处理。`);
      }
      break;
    }
    case 'rejected': {
      // 审核驳回 → 通知报修用户
      await sendNotification(reporterId, orderId, 'order_rejected', '工单审核驳回',
        `您的工单 ${orderNo}（${locationName}）被驳回${extra ? `，原因：${extra}` : ''}。`);
      break;
    }
    case 'accepted_repair': {
      // 维修人员接单 → 通知报修用户
      await sendNotification(reporterId, orderId, 'order_accepted_repair', '维修人员已接单',
        `您的工单 ${orderNo}（${locationName}）已被维修人员接单，正在维修中。`);
      break;
    }
    case 'repair_done': {
      // 维修完成（或返修后重新提交）→ 通知管理员验收/审核
      await sendNotificationBatch(await getAdminIds(), orderId, 'order_repair_done', '维修完成待处理',
        `工单 ${orderNo}（${locationName}）已完成维修${extra ? `，${extra}` : ''}，请及时处理。`);
      break;
    }
    case 'accepted': {
      // 验收通过 → 通知维修人员
      if (repairerId) {
        await sendNotification(repairerId, orderId, 'order_accepted', '验收通过',
          `您维修的工单 ${orderNo}（${locationName}）已验收通过。`);
      }
      break;
    }
    case 'returned': {
      // 验收退回 → 通知维修人员返修 + 通知报修用户
      if (repairerId) {
        await sendNotification(repairerId, orderId, 'order_returned', '验收退回返修',
          `您维修的工单 ${orderNo}（${locationName}）验收未通过${extra ? `，原因：${extra}` : ''}，请返修处理。`);
      }
      if (reporterId) {
        await sendNotification(reporterId, orderId, 'order_returned', '工单验收退回',
          `您的工单 ${orderNo}（${locationName}）验收未通过${extra ? `，原因：${extra}` : ''}，维修人员将重新维修。`);
      }
      break;
    }
    default:
      break;
  }
}

module.exports = { notifyOrderStatusChange, sendNotification };
