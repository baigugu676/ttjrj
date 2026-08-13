/**
 * 用户管理云函数（微信云开发）
 * 全部操作仅管理员可用。身份由调用者 OPENID 识别。
 *
 * 入参（action）：
 *   list    { role?, keyword?, page?, pageSize? }          用户列表（分页）
 *   create  { username, password, real_name?, role?, phone? } 创建用户
 *   update  { id, real_name?, role?, phone?, avatar_url?, password? } 编辑用户
 *   status  { id, status: 'active'|'disabled' }            启用/禁用
 *   delete  { id }                                         删除用户
 *
 * 返回统一格式：{ code: 0, data, message: 'success' }
 */
const cloud = require('wx-server-sdk');
const bcrypt = require('bcryptjs');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

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
      // ignore token miss and fallback to OPENID
    }
  }
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return null;
  const res = await db.collection('users').where({ openid: OPENID }).limit(1).get();
  return res.data[0] || null;
}

function safeUser(u) {
  const { password_hash, _id, ...rest } = u;
  return { ...rest, id: _id };
}

const VALID_ROLES = ['admin', 'user', 'repairer'];

exports.main = async (event) => {
  try {
    const user = await getCurrentUser(event);
    if (!user) return fail('未登录或 token 缺失');
    if (user.role !== 'admin') return fail('无权限执行该操作');

    const { action } = event || {};

    if (action === 'list') {
      const page = Math.max(1, Number(event.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(event.pageSize) || 20));
      const where = {};
      if (event.role && VALID_ROLES.includes(event.role)) where.role = event.role;
      const keyword = event.keyword ? String(event.keyword).trim().toLowerCase() : '';
      const res = await db.collection('users').where(where)
        .orderBy('created_at', 'asc').limit(1000).get();
      const filtered = keyword
        ? res.data.filter((u) => `${u.username || ''} ${u.real_name || ''} ${u.phone || ''}`.toLowerCase().includes(keyword))
        : res.data;
      const start = (page - 1) * pageSize;
      return ok({
        list: filtered.slice(start, start + pageSize).map(safeUser),
        total: filtered.length,
        page,
        pageSize
      });
    }

    if (action === 'create') {
      const { username, password, real_name = '', role = 'user', phone = '' } = event;
      const uname = username ? String(username).trim() : '';
      if (!uname || uname.length < 3 || uname.length > 30) {
        return fail('用户名长度需在 3-30 之间');
      }
      if (!/^[a-zA-Z0-9_]+$/.test(uname)) {
        return fail('用户名只能包含字母、数字和下划线');
      }
      if (!password || String(password).length < 6) {
        return fail('密码长度至少 6 位');
      }
      if (!VALID_ROLES.includes(role)) {
        return fail('角色不合法');
      }
      if (phone && !/^1\d{10}$/.test(phone)) {
        return fail('手机号格式不正确');
      }
      const exists = await db.collection('users').where({ username: uname }).limit(1).get();
      if (exists.data.length) return fail('用户名已存在');
      const hash = await bcrypt.hash(password, 10);
      const add = await db.collection('users').add({
        data: {
          username: uname,
          password_hash: hash,
          openid: '',
          real_name,
          role,
          phone,
          avatar_url: '',
          status: 'active',
          created_at: db.serverDate(),
          updated_at: db.serverDate()
        }
      });
      return ok({ id: add._id });
    }

    if (action === 'update') {
      const { id } = event;
      const data = {};
      if (event.real_name !== undefined) data.real_name = event.real_name;
      if (event.role !== undefined) {
        if (!VALID_ROLES.includes(event.role)) return fail('角色不合法');
        data.role = event.role;
      }
      if (event.phone !== undefined) {
        if (event.phone !== null && event.phone !== '' && !/^1\d{10}$/.test(event.phone)) {
          return fail('手机号格式不正确');
        }
        data.phone = event.phone;
      }
      if (event.avatar_url !== undefined) data.avatar_url = event.avatar_url;
      if (event.password) {
        if (String(event.password).length < 6) return fail('密码长度至少 6 位');
        data.password_hash = await bcrypt.hash(event.password, 10);
      }
      if (!Object.keys(data).length) return fail('没有需要更新的字段');
      data.updated_at = db.serverDate();
      try {
        await db.collection('users').doc(id).update({ data });
      } catch (e) {
        return fail('用户不存在');
      }
      return ok(null);
    }

    if (action === 'status') {
      const { id, status } = event;
      if (!['active', 'disabled'].includes(status)) {
        return fail('状态不合法（active/disabled）');
      }
      if (id === user._id && status === 'disabled') {
        return fail('不能禁用当前登录账号');
      }
      try {
        await db.collection('users').doc(id).update({
          data: { status, updated_at: db.serverDate() }
        });
      } catch (e) {
        return fail('用户不存在');
      }
      return ok(null);
    }

    if (action === 'delete') {
      const { id } = event;
      if (id === user._id) return fail('不能删除当前登录账号');
      const linked = await db.collection('work_orders').where(
        _.or([{ reporter_id: id }, { assigned_repairer_id: id }, { reviewer_id: id }])
      ).limit(1).get();
      if (linked.data.length) return fail('该用户存在关联的工单等数据，无法删除');
      try {
        await db.collection('users').doc(id).remove();
      } catch (e) {
        return fail('用户不存在');
      }
      return ok(null);
    }

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
