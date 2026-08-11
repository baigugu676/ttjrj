const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: { keyword: '', status: '', statuses: [{ key: '', text: '全部' }, { key: 'normal', text: '正常' }, { key: 'fault', text: '故障中' }, { key: 'repairing', text: '维修中' }], monitors: [], loading: true, error: '' },
  onLoad(options) { const status = options && options.status ? options.status : ''; this.setData({ status }); this.load({ status }); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },
  onSearch(e) { const keyword = e.detail.value || ''; this.setData({ keyword }); this.load({ keyword }); },
  chooseStatus(e) { const status = e.currentTarget.dataset.status || ''; this.setData({ status }); this.load({ status }); },
  load(overrides) {
    const params = Object.assign({ keyword: this.data.keyword, status: this.data.status }, overrides || {});
    const requestId = (this._requestId || 0) + 1;
    this._requestId = requestId;
    this.setData({ loading: true, error: '' });
    return api.getMonitorStatus(params, { loading: false, silent: true })
      .then((list) => {
        if (requestId !== this._requestId) return;
        this.setData({ monitors: Array.isArray(list) ? list.map((m) => Object.assign({}, m, { statusColor: util.getMonitorStatusColor(m.status), lastActionText: util.formatTime(m.lastActionAt) || '暂无记录' })) : [] });
      })
      .catch(() => { if (requestId === this._requestId) this.setData({ error: '监控状态加载失败，请重试', monitors: [] }); })
      .finally(() => { if (requestId === this._requestId) this.setData({ loading: false }); });
  },
  retry() { this.load(); },
  openDetail(e) { wx.navigateTo({ url: '/pages/monitor/detail/detail?id=' + e.currentTarget.dataset.id }); }
});
