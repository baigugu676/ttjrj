// 数据统计看板（管理员）：概览 + 状态分布 + 点位排行 + 维修工作量
const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

Page({
  data: {
    overview: {},            // 概览：today_new / pending / month_completed / avg_duration
    avgDurationText: '-',    // 平均时长展示文案
    statusDist: [],          // 状态分布 [{ status, text, color, count, percent }]
    locationRank: [],        // 点位故障排行
    repairerWorkload: []     // 维修人员工作量
  },

  onLoad() {
    const app = getApp();
    if (!app.checkLogin()) return;
    // 角色权限控制：仅管理员可访问
    if (app.getRole() !== 'admin') {
      wx.showToast({ title: '仅管理员可访问', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1000);
      return;
    }
    this.loadAll();
  },

  onShow() {
    // 从首页进入时刷新
    if (getApp().getRole() === 'admin') {
      this.loadAll();
    }
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  loadAll() {
    const overviewReq = api.get('/statistics/overview', {}, { loading: false }).catch(() => ({}));
    const distReq = api.get('/statistics/status-distribution', {}, { loading: false }).catch(() => []);
    const locReq = api.get('/statistics/location-ranking', {}, { loading: false }).catch(() => []);
    const workReq = api.get('/statistics/repairer-workload', {}, { loading: false }).catch(() => []);

    return Promise.all([overviewReq, distReq, workReq, locReq]).then(([overview, dist, workload, locRank]) => {
      // 状态分布：补充文案、颜色、百分比
      const distList = this.extractList(dist);
      const statusDist = distList.map((item) => {
        const status = item.status || item.order_status || '';
        const info = util.STATUS_MAP[status] || { text: '未知', color: '#999999' };
        return {
          status,
          text: item.text || info.text,
          color: item.color || info.color,
          count: item.count || 0,
          percent: 0
        };
      });
      const max = Math.max.apply(null, statusDist.map((d) => d.count).concat([1]));
      statusDist.forEach((d) => { d.percent = Math.round(d.count / max * 100); });

      // 平均时长展示（小时，小于1小时显示分钟）
      const avg = overview.avg_duration != null ? overview.avg_duration : overview.avgDuration;
      let avgDurationText = '-';
      if (avg != null && avg !== '') {
        const n = Number(avg);
        avgDurationText = n >= 1 ? (Math.round(n * 10) / 10) + ' 小时' : Math.round(n * 60) + ' 分钟';
      }

      this.setData({
        overview: overview || {},
        avgDurationText,
        statusDist,
        locationRank: this.extractList(locRank),
        repairerWorkload: this.extractList(workload)
      });
    });
  },

  extractList(res) {
    if (Array.isArray(res)) return res;
    if (res && res.list) return res.list;
    return [];
  }
});
