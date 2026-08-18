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
    if (!util.guardRole('repairer')) return;
    // 支持从首页或其他入口预设 tab（URL 参数优先，其次 Storage）
    const presetTab = (options && options.tab) || wx.getStorageSync('mytasksTab') || '';
    if (presetTab) {
      this.setData({ tab: presetTab });
      wx.removeStorageSync('mytasksTab');
    }
    this._initialLoad = true;
    this.loadList(true);
  },

  onShow() {
    // 从维修执行页返回时刷新（空列表也刷新，避免状态已变化的工单停留旧数据）；
    // 首次进入跳过（onLoad 已触发），避免首屏重复请求
    if (this._initialLoad) {
      this._initialLoad = false;
      return;
    }
    if (getApp().getRole() === 'repairer') {
      this.loadList(true);
    }
  },

  // 返回首页（本页由「工单」tab reLaunch 进入，tabBar 不可见，需提供出口）
  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
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
      completed_today: this.data.tab === 'today_completed' ? 1 : 0,
      page: target,
      pageSize
    }, { loading: false }).then((res) => {
      const rows = util.extractList(res);

      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch((err) => {
      console.error('[mytasks] 加载任务列表失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: (err && err.message) || '任务列表加载失败', icon: 'none' });
    }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  getMyId() {
    const app = getApp();
    const info = app.getUserInfo() || {};
    return info.id;
  },

  onPullDownRefresh() {
    this.loadList(true);
  },

  onReachBottom() {
    this.loadList(false);
  },

  // 点击工单卡片查看详情（order-card 的 tap 事件）
  goDetail(e) {
    const id = e.detail && e.detail.id;
    if (id) wx.navigateTo({ url: '/pages/report/detail/detail?id=' + id });
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
