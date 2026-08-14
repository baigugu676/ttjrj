/**
 * 微信订阅消息发送（REST 版，服务端直连微信 API）
 *
 * 需要 .env 配置：WX_APPID、WX_SECRET；模板按角色配置（下方 TEMPLATES）：
 *   WX_TEMPLATE_USER / WX_TEMPLATE_REPAIRER / WX_TEMPLATE_ADMIN
 * 未配置时静默跳过（不影响业务）。
 *
 * 一次性订阅额度存 subscribe_records 表（前端授权成功后登记），发送成功后消耗一条。
 * 模板字段关键词（titleField/contentField）按公众平台模板详情中的关键词填写。
 */
const pool = require('../config/db');

// ═══════════════ 微信订阅消息模板配置（REST 版，只需改这里） ═══════════════
// templateId 从 .env 读取（WX_TEMPLATE_USER / WX_TEMPLATE_REPAIRER / WX_TEMPLATE_ADMIN），
// 留空则该角色的推送自动跳过。
// titleField / contentField 填该模板中用于展示「标题/详情」的字段关键词
// （公众平台 → 订阅消息 → 我的模板 → 详情 中查看，如 thing1/thing2/phrase3）。
const TEMPLATES = {
  user:     { templateId: process.env.WX_TEMPLATE_USER || '', titleField: 'thing1', contentField: 'thing2' },
  repairer: { templateId: process.env.WX_TEMPLATE_REPAIRER || '', titleField: 'thing1', contentField: 'thing2' },
  admin:    { templateId: process.env.WX_TEMPLATE_ADMIN || '', titleField: 'thing1', contentField: 'thing2' }
};

// access_token 缓存（提前 5 分钟过期，避免并发互刷）
let cachedToken = null;
let cachedTokenExp = 0;

async function getAccessToken() {
  const { WX_APPID, WX_SECRET } = process.env;
  if (!WX_APPID || !WX_SECRET) return null;
  if (cachedToken && cachedTokenExp > Date.now()) return cachedToken;
  const res = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${WX_APPID}&secret=${WX_SECRET}`
  );
  const data = await res.json();
  if (data && data.access_token) {
    cachedToken = data.access_token;
    cachedTokenExp = Date.now() + ((Number(data.expires_in) || 7200) - 300) * 1000;
    return cachedToken;
  }
  console.warn('[wechat] 获取 access_token 失败:', data && (data.errmsg || data.errcode));
  return null;
}

/**
 * 给指定用户发送订阅消息（未配置/无额度/失败时静默跳过）
 * @param {number} userId    接收人 users.id
 * @param {string} title     消息标题
 * @param {string} content   消息内容
 * @param {string} pagePath  点击消息跳转的小程序页面
 */
async function sendSubscribeMessage(userId, title, content, pagePath) {
  try {
    if (!userId) return;
    const token = await getAccessToken();
    if (!token) return;
    const [users] = await pool.query(
      `SELECT openid, role, status FROM users WHERE id = ?`,
      [userId]
    );
    if (users.length === 0 || !users[0].openid || users[0].status !== 'active') return;
    const tpl = TEMPLATES[users[0].role];
    if (!tpl || !tpl.templateId) return; // 该角色模板未配置

    // 一次性订阅额度
    const [quota] = await pool.query(
      `SELECT id FROM subscribe_records WHERE user_id = ? AND template_id = ? ORDER BY id ASC LIMIT 1`,
      [userId, tpl.templateId]
    );
    if (quota.length === 0) return;

    // 按模板配置的字段关键词组装 data（thing 类字段上限 20 字）
    const msgData = {};
    msgData[tpl.titleField] = { value: String(title || '工单提醒').slice(0, 20) };
    msgData[tpl.contentField] = { value: String(content || '').slice(0, 20) };

    const res = await fetch(
      `https://api.weixin.qq.com/cgi-bin/message/subscribe/send?access_token=${token}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          touser: users[0].openid,
          template_id: tpl.templateId,
          page: pagePath || 'pages/index/index',
          data: msgData
        })
      }
    );
    const data = await res.json();
    if (data && data.errcode === 0) {
      // 发送成功才消耗额度
      await pool.query(`DELETE FROM subscribe_records WHERE id = ?`, [quota[0].id]).catch(() => {});
    } else {
      console.warn('[wechat] 订阅消息发送失败:', data && (data.errmsg || data.errcode));
    }
  } catch (err) {
    console.warn('[wechat] 订阅消息发送异常（不影响业务）:', err.message);
  }
}

module.exports = { sendSubscribeMessage, getAccessToken };
