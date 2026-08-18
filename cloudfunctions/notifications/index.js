/**
 * 消息通知云函数（微信云开发）
 * 仅操作当前用户（按 _token 识别）自己的通知。
 *
 * 入参（action）：
 *   list        { is_read?, page?, pageSize? }   通知列表
 *   unreadCount                                 未读数量
 *   read        { id }                          标记单条已读
 *   readAll                                     全部标记已读
 *
 * 返回统一格式：{ code: 0, data, message: 'success' }
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

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
 * 身份以 _token（登录返回的用户 _id）为唯一凭据，权限由该用户的角色（role）决定，
 * 不再以 openid 作为身份识别或权限判断依据。
 */
async function getCurrentUser(event) {
  const token = event && event._token ? String(event._token) : '';
  if (!token) return null;
  try {
    const byToken = await db.collection('users').doc(token).get();
    const u = byToken.data;
    if (!u) return null;
    return u.status === 'disabled' ? DISABLED_USER : u;
  } catch (e) {
    return null;
  }
}

exports.main = async (event) => {
  try {
    const user = await getCurrentUser(event);
    if (!user) return fail('未登录或 token 缺失');
    if (user === DISABLED_USER) return fail('账号已被禁用，请联系管理员');

    const { action } = event || {};

    if (action === 'list') {
      const page = Math.max(1, Number(event.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(event.pageSize) || 20));
      const where = { user_id: user._id };
      if (event.is_read !== undefined) {
        const isRead = Number(event.is_read);
        if (isRead === 0 || isRead === 1) where.is_read = isRead === 1;
      }
      const base = db.collection('notifications').where(where);
      const totalRes = await base.count();
      const res = await base
        .orderBy('created_at', 'desc')
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .get();
      return ok({
        list: res.data.map((n) => ({ ...n, id: n._id })),
        total: totalRes.total,
        page,
        pageSize
      });
    }

    if (action === 'unreadCount') {
      const res = await db.collection('notifications')
        .where({ user_id: user._id, is_read: false })
        .count();
      return ok({ unread_count: res.total });
    }

    if (action === 'read') {
      if (!event.id) return fail('通知ID不合法');
      const res = await db.collection('notifications')
        .where({ _id: event.id, user_id: user._id })
        .update({ data: { is_read: true } });
      if (!res.stats || res.stats.updated === 0) return fail('通知不存在');
      return ok(null);
    }

    if (action === 'readAll') {
      await db.collection('notifications')
        .where({ user_id: user._id, is_read: false })
        .update({ data: { is_read: true } });
      return ok(null);
    }

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
