/**
 * 订阅消息发送辅助模块（微信云调用）
 *
 * 机制（一次性订阅）：
 *   1. 小程序端 wx.requestSubscribeMessage 授权成功后调用 users.subscribeSelf，
 *      在 subscribe_records 集合登记一条额度记录（user_id + template_id）；
 *   2. 业务通知发生时调用 sendSubscribeMessage，按接收人角色选取模板，
 *      查询其订阅额度，调用 cloud.openapi.subscribeMessage.send 推送；
 *   3. 发送成功后消耗一条额度记录。
 *
 * 模板未配置（TEMPLATE_IDS 留空）或额度不足时静默跳过，不影响业务。
 *
 * ⚠ 接入真实模板时：send 的 data 字段名（thing1/thing2）需按所申请模板的
 * 实际字段（thing{n}/phrase{n}/time{n} 等）调整。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// 微信订阅消息模板 ID（与小程序端 utils/subscribe-config.js 保持一致）
// 在微信公众平台「功能 → 订阅消息」申请模板后填入；留空则对应角色推送自动跳过
const TEMPLATE_IDS = {
  user: '',      // 报修用户：工单进度通知
  repairer: '',  // 维修人员：新任务/验收结果通知
  admin: ''      // 管理员：新工单/维修完成提醒
};

/**
 * 给指定用户发送订阅消息（失败/未配置/无额度时静默跳过）
 * @param {String} userId    接收人 user _id
 * @param {String} title     消息标题（用于模板首字段）
 * @param {String} content   消息内容（用于模板详情字段）
 * @param {String} pagePath  点击消息跳转的小程序页面
 */
async function sendSubscribeMessage(userId, title, content, pagePath) {
  try {
    if (!userId) return;
    let user = null;
    try {
      const res = await db.collection('users').doc(String(userId)).get();
      user = res.data || null;
    } catch (err) {
      return; // 用户不存在
    }
    if (!user || user.status !== 'active' || !user.openid) return;
    const templateId = TEMPLATE_IDS[user.role];
    if (!templateId) return; // 该角色模板未配置

    // 查询订阅额度（一次性订阅：每次授权=一条额度）
    let quotaRes = null;
    try {
      quotaRes = await db.collection('subscribe_records')
        .where({ user_id: String(userId), template_id: templateId })
        .limit(1)
        .get();
    } catch (err) {
      return; // 集合不存在（未初始化）时跳过
    }
    if (!quotaRes.data || !quotaRes.data.length) return;

    const sendRes = await cloud.openapi.subscribeMessage.send({
      touser: user.openid,
      templateId,
      page: pagePath || 'pages/index/index',
      data: {
        thing1: { value: String(title || '工单提醒').slice(0, 20) },
        thing2: { value: String(content || '').slice(0, 20) }
      }
    });
    // 发送成功才消耗额度（errCode 0 为成功）
    if (sendRes && sendRes.errCode === 0) {
      await db.collection('subscribe_records').doc(quotaRes.data[0]._id).remove().catch(() => {});
    }
  } catch (err) {
    // 模板字段不匹配/接口权限不足等：仅记录日志，不影响业务
    console.warn('[orders] 订阅消息发送失败（不影响业务）:', err && (err.errMsg || err.message));
  }
}

module.exports = sendSubscribeMessage;
