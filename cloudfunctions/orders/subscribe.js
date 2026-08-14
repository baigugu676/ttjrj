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
 * 模板未配置（templateId 留空）或额度不足时静默跳过，不影响业务。
 * 模板 ID 与字段关键词均在下方 TEMPLATES 配置块中填写，无需改动其他代码。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

// ═══════════════ 微信订阅消息模板配置（只需改这里） ═══════════════
// 申请步骤见 miniprogram/utils/subscribe-config.js 顶部注释。
//
// 每角色一个模板，三个字段：
//   templateId   —— 模板 ID（微信公众平台「功能 → 订阅消息 → 我的模板」里查看）；
//                   留空则该角色的推送自动跳过（不影响任何其他功能）。
//   titleField   —— 模板中用来展示「标题/服务名称」的字段关键词（如 thing1）
//   contentField —— 模板中用来展示「详情/进度」的字段关键词（如 thing2）
//
// 字段关键词查看方法：公众平台 → 订阅消息 → 我的模板 → 点该模板「详情」，
// 每个字段右侧会标出关键词（thing{n}/phrase{n}/time{n} 等），照抄填入即可。
const TEMPLATES = {
  user:     { templateId: '', titleField: 'thing1', contentField: 'thing2' }, // 报修用户：工单进度通知
  repairer: { templateId: '', titleField: 'thing1', contentField: 'thing2' }, // 维修人员：新任务/验收结果通知
  admin:    { templateId: '', titleField: 'thing1', contentField: 'thing2' }  // 管理员：新工单/维修完成提醒
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
    const tpl = TEMPLATES[user.role];
    if (!tpl || !tpl.templateId) return; // 该角色模板未配置

    // 查询订阅额度（一次性订阅：每次授权=一条额度）
    let quotaRes = null;
    try {
      quotaRes = await db.collection('subscribe_records')
        .where({ user_id: String(userId), template_id: tpl.templateId })
        .limit(1)
        .get();
    } catch (err) {
      return; // 集合不存在（未初始化）时跳过
    }
    if (!quotaRes.data || !quotaRes.data.length) return;

    // 按模板配置的字段关键词组装 data（thing 类字段上限 20 字）
    const data = {};
    data[tpl.titleField] = { value: String(title || '工单提醒').slice(0, 20) };
    data[tpl.contentField] = { value: String(content || '').slice(0, 20) };

    const sendRes = await cloud.openapi.subscribeMessage.send({
      touser: user.openid,
      templateId: tpl.templateId,
      page: pagePath || 'pages/index/index',
      data
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
