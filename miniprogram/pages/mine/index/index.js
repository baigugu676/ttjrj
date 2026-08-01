// 我的（个人中心）：按角色显示功能菜单，退出登录
const util = require('../../utils/util.js');

Page({
  data: {
    userInfo: {},
    role: '',
    roleText: ''
  },

  onShow() {
    const app = getApp();
    if (!app.checkLogin()) return;
    const userInfo = app.getUserInfo() || {};
    this.setData({
      userInfo,
      role: userInfo.role || '',
      roleText: util.getRoleText(userInfo.role)
    });
  },

  // 菜单跳转
  goPage(e) {
    const url = e.currentTarget.dataset.url;
    // 工单列表是 tabBar 页面，使用 switchTab
    if (url === '/pages/report/list') {
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
