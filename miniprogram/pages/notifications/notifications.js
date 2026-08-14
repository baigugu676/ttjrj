// 消息通知页：展示当前用户的通知列表，支持标记已读、全部已读、跳转工单详情
const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

Page({
  data: {
    list: [],
    page: 1,
    pageSize: 20,
    hasMore: true,
    loading: false
  },

  onLoad() {
    const app = getApp();
    if (!app.checkLogin()) return;
    this.loadList(true);
  },

  onShow() {
    // 每次进入页面刷新
    this.loadList(true);
  },

  loadList(reset) {
    const { page, pageSize, hasMore, loading } = this.data;
    if (!reset && (!hasMore || loading)) return;
    const target = reset ? 1 : page + 1;
    this.setData({ loading: true });
    api.get('/notifications', {
      page: target,
      pageSize
    }, { loading: false }).then((res) => {
      const rows = this.formatList(this.extractList(res));
      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch((err) => {
      console.error('[notifications] 加载通知失败:', err);
      this.setData({ loading: false });
    }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  extractList(res) {
    if (Array.isArray(res)) return res;
    if (res && res.list) return res.list;
    return [];
  },

  formatList(rows) {
    return rows.map((n) => ({
      ...n,
      id: n.id || n._id,
      created_at_text: util.formatTime(n.created_at)
    }));
  },

  onPullDownRefresh() {
    this.loadList(true);
  },

  onReachBottom() {
    this.loadList(false);
  },

  // 标记单条已读
  markRead(e) {
    const id = e.currentTarget.dataset.id;
    const index = e.currentTarget.dataset.index;
    api.put('/notifications/' + id + '/read', {}, { loading: false, silent: true }).then(() => {
      const list = this.data.list.slice();
      if (list[index]) list[index].is_read = true;
      this.setData({ list });
      getApp().refreshUnreadBadge();
    }).catch(() => {});
  },

  // 全部标记已读
  markAllRead() {
    const unreadCount = this.data.list.filter((n) => !n.is_read).length;
    if (!unreadCount) {
      wx.showToast({ title: '没有未读消息', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '全部已读',
      content: '确认将所有' + unreadCount + '条通知标记为已读？',
      confirmColor: '#07C160',
      success: (res) => {
        if (!res.confirm) return;
        api.put('/notifications/read-all', {}, { loading: true, loadingText: '处理中...' }).then(() => {
          const list = this.data.list.map((n) => ({ ...n, is_read: true }));
          this.setData({ list });
          getApp().refreshUnreadBadge();
          wx.showToast({ title: '已全部标记为已读', icon: 'success' });
        }).catch(() => {});
      }
    });
  },

  // 点击通知跳转对应工单详情（同时标记已读）
  goOrder(e) {
    const { id, index, orderId } = e.currentTarget.dataset;
    // 先标记已读
    if (id) {
      api.put('/notifications/' + id + '/read', {}, { loading: false, silent: true }).catch(() => {});
      const list = this.data.list.slice();
      if (list[index]) list[index].is_read = true;
      this.setData({ list });
      getApp().refreshUnreadBadge();
    }
    // 跳转工单详情
    if (orderId) {
      wx.navigateTo({ url: '/pages/report/detail/detail?id=' + orderId });
    }
  }
});
