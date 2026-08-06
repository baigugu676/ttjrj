// 我的（个人中心）：按角色显示功能菜单，退出登录
const util = require('../../../utils/util.js');
const api = require('../../../utils/api.js');

Page({
  data: {
    userInfo: {},
    role: '',
    roleText: '',
    initial: '',
    unreadCount: 0
  },

  onShow() {
    const app = getApp();
    if (!app.checkLogin()) return;
    const raw = app.getUserInfo() || {};
    // 解析头像相对路径为完整 URL（避免 <image> 组件无法显示）
    const userInfo = Object.assign({}, raw);
    if (userInfo.avatar_url) userInfo.avatar_url = util.resolveImageUrl(userInfo.avatar_url);
    if (userInfo.avatar) userInfo.avatar = util.resolveImageUrl(userInfo.avatar);
    this.setData({
      userInfo,
      role: userInfo.role || '',
      roleText: util.getRoleText(userInfo.role),
      initial: (userInfo.real_name || userInfo.username || '用')[0]
    });
    this.loadUnreadCount();
  },

  // 查询未读通知数
  loadUnreadCount() {
    api.get('/notifications/unread-count', {}, { loading: false, silent: true }).then((res) => {
      const count = (res && res.unread_count) || 0;
      this.setData({ unreadCount: count });
    }).catch(() => {});
  },

  // 菜单跳转
  goPage(e) {
    const url = e.currentTarget.dataset.url;
    // 工单列表是 tabBar 页面，使用 switchTab
    if (url === '/pages/report/list/list') {
      wx.switchTab({ url });
    } else {
      wx.navigateTo({ url });
    }
  },

  // 退出登录
  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确认退出当前账号？',
      confirmColor: '#FA5151',
      success: (res) => {
        if (res.confirm) {
          getApp().logout();
        }
      }
    });
  }
});
