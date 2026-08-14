// 应用入口：管理全局登录态，提供登录/退出等通用方法
const api = require('./utils/api.js');

App({
  globalData: {
    token: '',      // 登录令牌
    userInfo: null  // 当前登录用户信息 { id, real_name, role, avatar_url, phone, ... }
  },

  onLaunch() {
    // 启动时从本地缓存恢复登录态
    this.globalData.token = wx.getStorageSync('token') || '';
    this.globalData.userInfo = wx.getStorageSync('userInfo') || null;
    if (this.globalData.token) this.refreshUnreadBadge();
  },

  // 保存登录信息（同时写入 globalData 与 Storage）
  setLoginInfo(token, userInfo) {
    this.globalData.token = token;
    this.globalData.userInfo = userInfo;
    wx.setStorageSync('token', token);
    wx.setStorageSync('userInfo', userInfo);
    this.refreshUnreadBadge();
  },

  refreshUnreadBadge() {
    if (!this.globalData.token) {
      wx.removeTabBarBadge({ index: 2 });
      return Promise.resolve(0);
    }
    return api.get('/notifications/unread-count', {}, { loading: false, silent: true })
      .then((data) => {
        const count = Number(data && data.unread_count) || 0;
        if (count > 0) {
          wx.setTabBarBadge({ index: 2, text: count > 99 ? '99+' : String(count) });
        } else {
          wx.removeTabBarBadge({ index: 2 });
        }
        return count;
      })
      .catch(() => 0);
  },

  // 检查登录状态：无 token 或已过期则自动跳转登录页
  // 注意：当前已在登录页时不能再 reLaunch，否则会自我重定向死循环导致白屏
  checkLogin() {
    if (this.globalData.token) return true;
    const pages = getCurrentPages();
    const route = pages.length ? pages[pages.length - 1].route : '';
    if (route !== 'pages/login/login') {
      wx.reLaunch({ url: '/pages/login/login' });
    }
    return false;
  },

  // 获取当前用户信息
  getUserInfo() {
    return this.globalData.userInfo;
  },

  // 获取当前角色：user(报修用户) / repairer(维修人员) / admin(管理员)
  getRole() {
    const info = this.globalData.userInfo;
    return info ? info.role : '';
  },

  // 账号密码登录：POST /auth/login
  login(username, password) {
    return api.post('/auth/login', { username, password }, { loading: false }).then((data) => {
      const token = data && (data.token || data.accessToken);
      const userInfo = data && (data.userInfo || data.user);
      if (!token || !userInfo) {
        throw new Error('登录失败：后端返回数据不完整');
      }
      this.setLoginInfo(token, userInfo);
      return userInfo;
    });
  },

  // 请求订阅消息授权：登录后调用一次（每自然日内最多一次，避免频繁打扰）
  // 模板未配置（subscribe-config.js 中留空）时自动跳过
  requestSubscribe() {
    const info = this.globalData.userInfo;
    if (!info || !info.role) return;
    const config = require('./utils/subscribe-config.js');
    const templateId = (config.TEMPLATE_IDS || {})[info.role];
    if (!templateId) return;
    const lastKey = 'subscribe_requested_at';
    const last = Number(wx.getStorageSync(lastKey)) || 0;
    if (Date.now() - last < 24 * 3600 * 1000) return;
    wx.requestSubscribeMessage({
      tmplIds: [templateId],
      success: (res) => {
        wx.setStorageSync(lastKey, Date.now());
        if (res[templateId] === 'accept') {
          // 授权成功：向云端登记一条订阅额度（一次性订阅，发送后消耗）
          api.callCloud('users', {
            action: 'subscribeSelf',
            template_ids: [templateId],
            _token: this.globalData.token || ''
          }, { loading: false, silent: true }).catch(() => {});
        }
      },
      fail: () => {}
    });
  },

  // 退出登录：清空本地登录态并跳转登录页
  logout() {
    this.globalData.token = '';
    this.globalData.userInfo = null;
    wx.removeStorageSync('token');
    wx.removeStorageSync('userInfo');
    wx.removeTabBarBadge({ index: 2 });
    wx.reLaunch({ url: '/pages/login/login' });
  }
});
