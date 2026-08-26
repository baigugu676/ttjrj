const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: { id: '', detail: null, timeline: [], loading: true, error: '' },
  onLoad(options) { this.setData({ id: options.id || '' }); this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  load() {
    if (!this.data.id) { this.setData({ loading: false, error: '监控参数缺失' }); return Promise.resolve(); }
    this.setData({ loading: true, error: '' });
    return api.getMonitorDetail(this.data.id, { loading: false, silent: true })
      .then((detail) => {
        const timeline = (detail && detail.timeline || []).slice().sort((a, b) => new Date(b.time) - new Date(a.time)).map((item) => Object.assign({}, item, { actionText: util.getMonitorActionText(item.action), timeText: util.formatTime(item.time), roleText: util.getRoleText(item.actorRole) }));
        const orders = (detail && detail.orders || []).map((item) => Object.assign({}, item, { statusText: util.getStatusText(item.status), createdText: util.formatTime(item.createdAt), updatedText: util.formatTime(item.updatedAt) }));
        this.setData({ detail: Object.assign({}, detail, { orders, statusColor: util.getMonitorStatusColor(detail.status), recentRepairText: util.formatTime(detail.metrics && detail.metrics.recentRepairAt) || '暂无记录' }), timeline });
      })
      .catch(() => this.setData({ detail: null, timeline: [], error: '监控详情加载失败，请重试' }))
      .finally(() => this.setData({ loading: false }));
  },
  retry() { this.load(); },
  openOrder(e) { const id = e.currentTarget.dataset.id; if (id) { const role = getApp().getRole(); const url = role === 'admin' ? '/pages/admin/order-detail/order-detail?id=' + id : '/pages/report/detail/detail?id=' + id; wx.navigateTo({ url }); } }
});
