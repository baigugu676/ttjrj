// 登录页：账号密码登录 + 微信一键登录
const app = getApp();

Page({
  data: {
    username: '',
    password: '',
    logging: false
  },

  onLoad() {
    // 已登录则直接进入首页
    if (app.checkLogin()) {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },

  onUsernameInput(e) {
    this.setData({ username: e.detail.value });
  },

  onPasswordInput(e) {
    this.setData({ password: e.detail.value });
  },

  // 账号密码登录
  onLogin() {
    const { username, password, logging } = this.data;
    if (logging) return;
    if (!username.trim()) {
      wx.showToast({ title: '请输入用户名', icon: 'none' });
      return;
    }
    if (!password) {
      wx.showToast({ title: '请输入密码', icon: 'none' });
      return;
    }
    this.setData({ logging: true });
    app.login(username.trim(), password).then(() => {
      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' });
      }, 800);
    }).catch((err) => {
      wx.showToast({ title: (err && err.message) || '登录失败', icon: 'none' });
      this.setData({ logging: false });
    });
  },

  // 微信一键登录：open-type="getUserInfo" 获取微信头像昵称
  onWxLogin(e) {
    if (this.data.logging) return;
    const profile = e.detail && e.detail.userInfo;
    if (!profile) {
      wx.showToast({ title: '请允许授权后再登录', icon: 'none' });
      return;
    }
    this.setData({ logging: true });
    app.wxLogin(profile).then(() => {
      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => {
        wx.switchTab({ url: '/pages/index/index' });
      }, 800);
    }).catch((err) => {
      wx.showToast({ title: (err && err.message) || '微信登录失败', icon: 'none' });
      this.setData({ logging: false });
    });
  }
});
