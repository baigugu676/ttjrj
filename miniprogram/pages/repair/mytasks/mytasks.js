// 我的维修任务（维修人员）：维修中 / 待验收 / 已完成，点击"进入维修"跳转维修执行页
const api = require('../../../utils/api.js');

Page({
  data: {
    tabs: [
      { label: '维修中', value: 'repairing' },
      { label: '待验收', value: 'pending_accept' },
      { label: '已完成', value: 'completed' },
      { label: '退回返修', value: 'repair_returned' }
    ],
    tab: 'repairing',   // 当前筛选状态
    list: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false
  },

  onLoad() {
    const app = getApp();
    if (!app.checkLogin()) return;
    // 角色权限控制：仅维修人员可访问
    if (app.getRole() !== 'repairer') {
      wx.showToast({ title: '仅维修人员可访问', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1000);
      return;
    }
    this.loadList(true);
  },

  onShow() {
    // 从维修执行页返回时刷新
    if (this.data.list.length && getApp().getRole() === 'repairer') {
      this.loadList(true);
    }
  },

  onTabChange(e) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.tab) return;
    this.setData({ tab: value });
    this.loadList(true);
  },

  loadList(reset) {
    const { page, pageSize, hasMore, loading } = this.data;
    if (!reset && (!hasMore || loading)) return;
    const target = reset ? 1 : page + 1;
    this.setData({ loading: true });
    api.get('/orders', {
      assigned_repairer_id: this.getMyId(),
      status: this.data.tab,
      page: target,
      pageSize
    }, { loading: false }).then((res) => {
      const rows = this.extractList(res);
      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch(() => {
      this.setData({ loading: false });
    }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  getMyId() {
    const app = getApp();
    const info = app.getUserInfo() || {};
    return info.id;
  },

  extractList(res) {
    if (Array.isArray(res)) return res;
    if (res && res.list) return res.list;
    return [];
  },

  onPullDownRefresh() {
    this.loadList(true);
  },

  onReachBottom() {
    this.loadList(false);
  },

  // 查看工单详情
  goDetail(e) {
    wx.navigateTo({ url: '/pages/report/detail/detail?id=' + e.detail.id });
  },

  // 进入维修执行页
  goExecute(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/repair/execute/execute?id=' + id });
  }
});
