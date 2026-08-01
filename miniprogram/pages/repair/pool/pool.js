// 待维修工单池（维修人员）：status=pending_repair 的工单列表 + 接单
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
    if (app.getRole() !== 'repairer') {
      wx.showToast({ title: '仅维修人员可访问', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1000);
      return;
    }
    this.loadList(true);
  },

  onShow() {
    // 从详情返回时刷新
    if (this.data.list.length && getApp().getRole() === 'repairer') {
      this.loadList(true);
    }
  },

  loadList(reset) {
    const { page, pageSize, hasMore, loading } = this.data;
    if (!reset && (!hasMore || loading)) return;
    const target = reset ? 1 : page + 1;
    this.setData({ loading: true });
    api.get('/orders', {
      status: 'pending_repair',
      page: target,
      pageSize
    }, { loading: false }).then((res) => {
      const rows = this.decorate(this.extractList(res));
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

  // 补充展示字段
  decorate(rows) {
    return rows.map((o) => Object.assign({}, o, {
      created_at_text: util.formatTime(o.created_at)
    }));
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

  // 接单：确认弹窗后调用 PUT /orders/:id/accept-repair
  onAccept(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '确认接单',
      content: '确认接取该维修工单？',
      confirmText: '确认接单',
      confirmColor: '#07C160',
      success: (res) => {
        if (!res.confirm) return;
        api.put('/orders/' + id + '/accept-repair', {}).then(() => {
          wx.showToast({ title: '接单成功', icon: 'success' });
          this.loadList(true);
        }).catch(() => {});
      }
    });
  }
});
