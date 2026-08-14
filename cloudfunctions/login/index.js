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
  // 剔除密码哈希与 openid（微信身份标识不应下发到客户端）
  const { password_hash, openid, _id, ...rest } = user;
  return { ...rest, id: _id };
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
        // 并发首登可能产生重复的同 openid 记录：保留最早一条，清理其余
        try {
          const all = await db.collection('users').where({ openid: OPENID }).orderBy('created_at', 'asc').limit(10).get();
          if (all.data.length > 1) {
            for (let i = 1; i < all.data.length; i++) {
              await db.collection('users').doc(all.data[i]._id).remove().catch(() => {});
            }
            user = all.data[0];
          }
        } catch (err) { /* 清理失败不影响登录 */ }
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
        // 仅当该 OPENID 未绑定其他账号时才绑定，避免抢占他人账号的微信登录
        const owner = await findUserByOpenid(OPENID);
        if (!owner || String(owner._id) === String(user._id)) {
          try {
            await db.collection('users').doc(user._id).update({
              data: { openid: OPENID, updated_at: db.serverDate() }
            });
            user.openid = OPENID;
          } catch (err) {
            // 忽略绑定失败，仍允许登录
          }
        }
      }
      return ok({ token: user._id, userInfo: toSafeUser(user) });
    }

    return fail('未知操作');
  } catch (err) {
    return fail(err.message || '服务器内部错误');
  }
};
