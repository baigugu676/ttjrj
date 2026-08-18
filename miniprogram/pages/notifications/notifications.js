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
    // 首次加载交给 onShow（onLoad 后必触发），避免首屏重复请求
  },

  onShow() {
    // 每次进入页面刷新
    if (getApp().globalData.token) {
      this.loadList(true);
    }
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
      const rows = this.formatList(util.extractList(res));
      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch((err) => {
      console.error('[notifications] 加载通知失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: (err && err.message) || '通知加载失败', icon: 'none' });
    }).finally(() => {
      wx.stopPullDownRefresh();
    });
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
      // 局部更新单条记录，避免 setData 整个列表
      if (this.data.list[index]) {
        this.setData({ ['list[' + index + '].is_read']: true });
      }
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
      // 局部更新单条记录，避免 setData 整个列表
      if (this.data.list[index]) {
        this.setData({ ['list[' + index + '].is_read']: true });
      }
      getApp().refreshUnreadBadge();
    }
    // 跳转工单详情：按角色分流，管理员可审核/验收也可维修（待接单/返修类通知直接进入维修执行页），维修人员按通知类型进入维修执行/详情
    if (orderId) {
      const role = getApp().getRole();
      const item = this.data.list[index] || {};
      const type = item.type;
      if (role === 'admin') {
        // 待接单（执行页会自动接单）与验收退回 → 直接进入维修执行页
        if (type === 'order_approved' || type === 'order_returned') {
          wx.navigateTo({ url: '/pages/repair/execute/execute?id=' + orderId });
        } else {
          wx.navigateTo({ url: '/pages/admin/order-detail/order-detail?id=' + orderId });
        }
      } else if (role === 'repairer') {
        // 新指派（待接单，执行页会自动接单）与验收退回 → 直接进入维修执行页
        if (type === 'order_approved' || type === 'order_returned') {
          wx.navigateTo({ url: '/pages/repair/execute/execute?id=' + orderId });
        } else {
          wx.navigateTo({ url: '/pages/report/detail/detail?id=' + orderId });
        }
      } else {
        wx.navigateTo({ url: '/pages/report/detail/detail?id=' + orderId });
      }
    }
  }
});
