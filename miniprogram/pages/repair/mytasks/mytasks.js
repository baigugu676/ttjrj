// 我的维修任务（维修人员）：维修中 / 待验收 / 已完成 / 今日完成 / 退回返修，点击"进入维修"跳转维修执行页
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: {
    tabs: [
      { label: '维修中', value: 'repairing' },
      { label: '待验收', value: 'pending_accept' },
      { label: '已完成', value: 'completed' },
      { label: '今日完成', value: 'today_completed' },
      { label: '退回返修', value: 'repair_returned' }
    ],
    tab: 'repairing',   // 当前筛选状态
    list: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false
  },

  onLoad(options) {
    const app = getApp();
    if (!app.checkLogin()) return;
    // 角色权限控制：仅维修人员可访问
    if (app.getRole() !== 'repairer') {
      wx.showToast({ title: '仅维修人员可访问', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1000);
      return;
    }
    // 支持从首页或其他入口预设 tab（URL 参数优先，其次 Storage）
    const presetTab = (options && options.tab) || wx.getStorageSync('mytasksTab') || '';
    if (presetTab) {
      this.setData({ tab: presetTab });
      wx.removeStorageSync('mytasksTab');
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

    // 今日完成：服务端按 completed 查询，客户端再按日期过滤
    const apiStatus = this.data.tab === 'today_completed' ? 'completed' : this.data.tab;

    api.get('/orders', {
      assigned_repairer_id: this.getMyId(),
      status: apiStatus,
      page: target,
      pageSize
    }, { loading: false }).then((res) => {
      let rows = this.extractList(res);

      // 今日完成：客户端按 updated_at 过滤当天
      if (this.data.tab === 'today_completed') {
        const today = util.formatTime(new Date(), 'YYYY-MM-DD');
        rows = rows.filter((o) => {
          const t = util.formatTime(o.updated_at || o.created_at, 'YYYY-MM-DD');
          return t === today;
        });
      }

      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch((err) => {
      console.error('[mytasks] 加载任务列表失败:', err);
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

  // 查看工单详情（通过 data-id 传参）
  goDetailById(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/report/detail/detail?id=' + id });
  },

  // 进入维修执行页（维修中/退回返修状态下可用）
  goExecute(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/repair/execute/execute?id=' + id });
  }
});
