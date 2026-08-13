const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: {
    keyword: '', status: '', page: 1, pageSize: 20, total: 0, hasMore: true,
    statuses: [{ key: '', text: '全部' }, { key: 'normal', text: '正常' }, { key: 'fault', text: '故障中' }, { key: 'repairing', text: '维修中' }],
    monitors: [], loading: true, error: ''
  },
  onLoad(options) {
    const status = options && options.status ? options.status : '';
    this._cache = new Map();
    this.setData({ status });
    this.load({ status }, true);
  },
  onUnload() { if (this._searchTimer) clearTimeout(this._searchTimer); },
  onPullDownRefresh() { this.load({}, true).finally(() => wx.stopPullDownRefresh()); },
  onReachBottom() { this.loadMore(); },
  onKeywordInput(e) {
    const keyword = e.detail.value || '';
    this.setData({ keyword });
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.load({}, false), 300);
  },
  onSearch() {
    if (this._searchTimer) clearTimeout(this._searchTimer);
    this.load({}, true);
  },
  chooseStatus(e) {
    const status = e.currentTarget.dataset.status || '';
    if (status === this.data.status) return;
    this.setData({ status });
    this.load({}, false);
  },
  loadMore() {
    if (this.data.loading || !this.data.hasMore) return Promise.resolve();
    return this.load({ page: this.data.page + 1 }, false, true);
  },
  load(overrides, force, append) {
    const page = overrides && overrides.page ? overrides.page : 1;
    const params = Object.assign({ keyword: this.data.keyword, status: this.data.status, page, pageSize: this.data.pageSize }, overrides || {});
    const cacheKey = [params.keyword, params.status, params.page, params.pageSize].join('|');
    const requestId = (this._requestId || 0) + 1;
    this._requestId = requestId;
    const cached = !force && this._cache && this._cache.get(cacheKey);
    if (cached && Date.now() - cached.time < 30000) {
      this.applyResult(cached.value, append);
      return Promise.resolve(cached.value);
    }
    this.setData({ loading: true, error: '' });
    return api.getMonitorStatus(params, { loading: false, silent: true })
      .then((result) => {
        if (requestId !== this._requestId) return;
        if (this._cache) this._cache.set(cacheKey, { time: Date.now(), value: result });
        this.applyResult(result, append);
      })
      .catch(() => { if (requestId === this._requestId) this.setData({ error: '监控状态加载失败，请重试', monitors: [] }); })
      .finally(() => { if (requestId === this._requestId) this.setData({ loading: false }); });
  },
  applyResult(result, append) {
    const list = Array.isArray(result) ? result : ((result && result.list) || []);
    const monitors = list.map((m) => Object.assign({}, m, {
      statusColor: util.getMonitorStatusColor(m.status),
      lastActionText: util.formatTime(m.lastActionAt) || '暂无记录'
    }));
    const page = (result && result.page) || 1;
    const pageSize = (result && result.pageSize) || this.data.pageSize;
    const total = (result && typeof result.total === 'number') ? result.total : monitors.length;
    this.setData({
      monitors: append ? this.data.monitors.concat(monitors) : monitors,
      page,
      total,
      hasMore: page * pageSize < total,
      error: ''
    });
  },
  retry() { this.load(); },
  openDetail(e) { wx.navigateTo({ url: '/pages/monitor/detail/detail?id=' + e.currentTarget.dataset.id }); }
});
