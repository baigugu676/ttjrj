/**
 * 用户管理云函数（微信云开发）
 * 全部操作仅管理员可用。身份以微信 OPENID 为唯一可信身份，
 * _token 仅作账号提示（必须与 OPENID 绑定一致才有效）。
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

// 对外输出时剔除敏感字段（password_hash、openid）
function safeUser(u) {
  const { password_hash, openid, _id, ...rest } = u;
  return { ...rest, id: _id };
}

const VALID_ROLES = ['admin', 'user', 'repairer'];

async function getActiveAdminCount() {
  const res = await db.collection('users').where({ role: 'admin', status: 'active' }).count();
  return res.total || 0;
}

exports.main = async (event) => {
  try {
    const user = await getCurrentUser(event);
    if (!user) return fail('未登录或 token 缺失');
    if (user === DISABLED_USER) return fail('账号已被禁用，请联系管理员');

    const { action } = event || {};

    if (user.role !== 'admin') return fail('无权限执行该操作');

    if (action === 'list') {
      const page = Math.max(1, Number(event.page) || 1);
      const pageSize = Math.min(100, Math.max(1, Number(event.pageSize) || 20));
      // 角色过滤下沉到数据库，分页拉全量后仅在内存做关键字过滤与分页
      let all = [];
      if (event.role && VALID_ROLES.includes(event.role)) {
        all = await fetchAll(db.collection('users').where({ role: event.role }).orderBy('created_at', 'asc'));
      } else {
        all = await fetchAll(db.collection('users').orderBy('created_at', 'asc'));
      }
      const keyword = event.keyword ? String(event.keyword).trim().toLowerCase() : '';
      const filtered = keyword
        ? all.filter((u) => `${u.username || ''} ${u.real_name || ''} ${u.phone || ''}`.toLowerCase().includes(keyword))
        : all;
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
      let target = null;
      try {
        target = (await db.collection('users').doc(id).get()).data;
      } catch (e) {
        return fail('用户不存在');
      }
      const data = {};
      if (event.real_name !== undefined) data.real_name = event.real_name;
      if (event.role !== undefined) {
        if (!VALID_ROLES.includes(event.role)) return fail('角色不合法');
        // 防呆：不能修改自己的角色；降级最后一名活跃管理员会导致系统无人管理
        if (String(id) === String(user._id) && event.role !== 'admin') {
          return fail('不能修改当前登录账号的角色');
        }
        if (target.role === 'admin' && event.role !== 'admin') {
          const adminCount = await getActiveAdminCount();
          if (adminCount <= 1) return fail('系统至少保留一名活跃管理员');
        }
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
      await db.collection('users').doc(id).update({ data });
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
      if (status === 'disabled') {
        // 不允许禁用最后一名活跃管理员
        let target = null;
        try {
          target = (await db.collection('users').doc(id).get()).data;
        } catch (e) {
          return fail('用户不存在');
        }
        if (target.role === 'admin') {
          const adminCount = await getActiveAdminCount();
          if (adminCount <= 1) return fail('系统至少保留一名活跃管理员');
        }
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
      let target = null;
      try {
        target = (await db.collection('users').doc(id).get()).data;
      } catch (e) {
        return fail('用户不存在');
      }
      if (target.role === 'admin') {
        const adminRes = await db.collection('users').where({ role: 'admin' }).count();
        if ((adminRes.total || 0) <= 1) return fail('系统至少保留一名管理员');
      }
      // 关联检查：工单、维修记录、验收记录、通知
      const linkedOrder = await db.collection('work_orders').where(
        _.or([{ reporter_id: id }, { assigned_repairer_id: id }, { reviewer_id: id }])
      ).limit(1).get();
      if (linkedOrder.data.length) return fail('该用户存在关联的工单等数据，无法删除');
      const [linkedRepair, linkedAccept, linkedNotify] = await Promise.all([
        db.collection('repair_records').where({ repairer_id: id }).limit(1).get(),
        db.collection('acceptance_records').where({ reviewer_id: id }).limit(1).get(),
        db.collection('notifications').where({ user_id: id }).limit(1).get()
      ]);
      if (linkedRepair.data.length || linkedAccept.data.length || linkedNotify.data.length) {
        return fail('该用户存在关联的维修/验收/通知数据，无法删除');
      }
      await db.collection('users').doc(id).remove();
      return ok(null);
    }

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
