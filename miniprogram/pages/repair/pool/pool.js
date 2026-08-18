// 待维修工单池（维修人员）：展示指派给自己的待接单/返修工单，并提供接单或进入返修
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: {
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
    if (!util.guardRole('repairer')) return;
    // 首次加载交给 onShow（onLoad 后必触发），避免首屏重复请求
  },

  onShow() {
    // 从详情返回时刷新（即使列表为空也要刷新，确保新退回的工单能立即显示）
    if (getApp().getRole() === 'repairer') {
      this.loadList(true);
    }
  },

  getMyId() {
    const app = getApp();
    const info = app.getUserInfo() || {};
    return info.id;
  },

  loadList(reset) {
    const { page, pageSize, hasMore, loading } = this.data;
    if (!reset && (!hasMore || loading)) return;
    const target = reset ? 1 : page + 1;
    this.setData({ loading: true });
    api.get('/orders', {
      assigned_repairer_id: this.getMyId(),
      status: 'pending_repair,repair_returned',
      page: target,
      pageSize
    }, { loading: false }).then((res) => {
      const rows = this.decorate(util.extractList(res));
      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch((err) => {
      console.error('[pool] 加载工单池失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: (err && err.message) || '工单池加载失败', icon: 'none' });
    }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 补充展示字段
  decorate(rows) {
    return rows.map((o) => Object.assign({}, o, {
      created_at_text: util.formatTime(o.created_at),
      status_text: o.status === 'repair_returned' ? '返修' : '维修',
      status_subtext: util.getStatusText(o.status),
      action_text: o.status === 'repair_returned' ? '去返修' : '接 单',
      action_type: o.status === 'repair_returned' ? 'repair' : 'accept'
    }));
  },

  onPullDownRefresh() {
    this.loadList(true);
  },

  onReachBottom() {
    this.loadList(false);
  },

  // 待接单工单：确认后调用 PUT /orders/:id/accept-repair
  // 返修工单：直接进入维修执行页
  onAction(e) {
    const { id, actionType } = e.currentTarget.dataset;
    if (actionType === 'repair') {
      wx.navigateTo({ url: '/pages/repair/execute/execute?id=' + id });
      return;
    }
    // 防重复接单：请求进行中忽略再次点击
    if (this._accepting) return;
    wx.showModal({
      title: '确认接单',
      content: '确认接取该维修工单？',
      confirmText: '确认接单',
      confirmColor: '#07C160',
      success: (res) => {
        if (!res.confirm) return;
        this._accepting = true;
        api.put('/orders/' + id + '/accept-repair', {}).then(() => {
          wx.showToast({ title: '接单成功', icon: 'success' });
          this.loadList(true);
        }).catch((err) => {
          // 显示具体的失败原因，帮助维修员排查
          wx.showToast({ title: (err && err.message) || '接单失败，请重试', icon: 'none', duration: 2500 });
        }).finally(() => {
          this._accepting = false;
        });
      }
    });
  }
});
