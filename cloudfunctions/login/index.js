/**
 * 登录云函数（微信云开发）
 *
 * 入参：
 *   action: 'wechat'                      微信一键登录（按 OPENID 识别，未注册则自动创建报修用户）
 *     { nickname?, avatar? }
 *   action: 'password'                    账号密码登录（成功后绑定当前微信 OPENID，便于后续一键登录）
 *     { username, password }
 *
 * 返回统一格式：{ code: 0, data: { token, userInfo }, message: 'success' }
 *   token    = 用户 _id（云开发环境下身份由 OPENID 识别，token 仅用于小程序端登录态兼容）
 *   userInfo = { id, username, real_name, role, phone, avatar_url, status, ... }（不含密码哈希）
 */
const cloud = require('wx-server-sdk');
const bcrypt = require('bcryptjs');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

function ok(data) {
  return { code: 0, message: 'success', data };
}

function fail(message, code = 1) {
  return { code, message };
}

function toSafeUser(user) {
  if (!user) return null;
  const { password_hash, _id, ...rest } = user;
  return { ...rest, id: _id };
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

async function findUserByOpenid(openid) {
  if (!openid) return null;
  try {
    const res = await db.collection('users').where({ openid }).limit(1).get();
    return res.data[0] || null;
  } catch (err) {
    return null;
  }
}

async function findUserByUsername(username) {
  if (!username) return null;
  try {
    const res = await db.collection('users').where({ username: String(username).trim() }).limit(1).get();
    return res.data[0] || null;
  } catch (err) {
    return null;
  }
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const { action } = event || {};

  try {
    await ensureCollection('users');
    // 微信一键登录：按 OPENID 识别用户，未注册则自动创建报修用户
    if (action === 'wechat') {
      let user = await findUserByOpenid(OPENID);
      if (!user) {
        const data = {
          username: 'wx_' + (OPENID ? OPENID.slice(-8) : String(Date.now())),
          openid: OPENID || '',
          real_name: (event && (event.nickname || event.real_name)) || '微信用户',
          avatar_url: (event && (event.avatar || event.avatar_url)) || '',
          role: 'user',
          phone: '',
          status: 'active',
          created_at: db.serverDate(),
          updated_at: db.serverDate()
        };
        try {
          const add = await db.collection('users').add({ data });
          user = (await db.collection('users').doc(add._id).get()).data;
        } catch (err) {
          return fail('用户数据初始化失败，请先在云开发控制台创建 users 集合');
        }
      }
      if (!user) {
        return fail('用户不存在，请先注册或联系管理员');
      }
      if (user.status !== 'active') {
        return fail('账号已被禁用，请联系管理员');
      }
      return ok({ token: user._id, userInfo: toSafeUser(user) });
    }

    // 账号密码登录
    if (action === 'password') {
      const { username, password } = event || {};
      if (!username || !password) {
        return fail('用户名和密码不能为空');
      }
      const user = await findUserByUsername(username);
      if (!user || !user.password_hash) {
        return fail('用户名或密码错误');
      }
      let isMatch = false;
      try {
        isMatch = await bcrypt.compare(password, user.password_hash);
      } catch (err) {
        isMatch = false;
      }
      if (!isMatch) {
        return fail('用户名或密码错误');
      }
      if (user.status !== 'active') {
        return fail('账号已被禁用，请联系管理员');
      }
      if (OPENID && user.openid !== OPENID) {
        try {
          await db.collection('users').doc(user._id).update({
            data: { openid: OPENID, updated_at: db.serverDate() }
          });
          user.openid = OPENID;
        } catch (err) {
          // 忽略绑定失败，仍允许登录
        }
      }
      return ok({ token: user._id, userInfo: toSafeUser(user) });
    }

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
