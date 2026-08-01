// 数据统计看板（管理员）：概览 + 状态分布 + 点位排行 + 维修工作量
// 数据字段与后端 /api/statistics/* 对齐后，统一归一化为展示字段
const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

Page({
  data: {
    overview: {},            // 归一化概览：today_new / pending / month_completed
    avgDurationText: '-',    // 平均时长展示文案
    statusDist: [],          // 状态分布 [{ status, text, color, count, percent }]
    locationRank: [],        // 点位故障排行 [{ name, count }]
    repairerWorkload: []     // 维修人员工作量 [{ name, count }]
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
      // ---- 概览：兼容后端字段 pending_count / month_completed / today_new / avg_repair_minutes ----
      const ov = overview || {};
      const normalizedOverview = {
        today_new: ov.today_new || 0,
        pending: ov.pending_count != null ? ov.pending_count : (ov.pending || 0),
        month_completed: ov.month_completed || 0
      };

      // 平均时长：后端返回分钟（avg_repair_minutes），超过 60 分钟显示为小时
      let avgDurationText = '-';
      const avgMinutes = ov.avg_repair_minutes != null ? ov.avg_repair_minutes : ov.avg_duration;
      if (avgMinutes != null && avgMinutes !== '') {
        const n = Number(avgMinutes);
        if (!Number.isNaN(n)) {
          avgDurationText = n >= 60 ? (Math.round(n / 60 * 10) / 10) + ' 小时' : Math.round(n) + ' 分钟';
        }
      }

      // ---- 状态分布：兼容后端 { status, label, count } ----
      const distList = this.extractList(dist);
      const statusDist = distList.map((item) => {
        const status = item.status || item.order_status || '';
        const info = util.STATUS_MAP[status] || { text: '未知', color: '#999999' };
        return {
          status,
          text: item.text || item.label || info.text,
          color: item.color || info.color,
          count: Number(item.count) || 0,
          percent: 0
        };
      });
      const max = Math.max.apply(null, statusDist.map((d) => d.count).concat([1]));
      statusDist.forEach((d) => { d.percent = Math.round(d.count / max * 100); });

      // ---- 点位故障排行：后端返回 fault_count ----
      const locationRank = this.extractList(locRank).map((item) => ({
        name: item.name || item.location_name || '未知点位',
        count: Number(item.fault_count != null ? item.fault_count : item.count) || 0
      }));

      // ---- 维修人员工作量：后端返回 total_assigned / real_name ----
      const repairerWorkload = this.extractList(workload).map((item) => ({
        name: item.real_name || item.name || item.repairer_name || '维修人员',
        count: Number(item.total_assigned != null ? item.total_assigned : item.count) || 0
      }));

      this.setData({
        overview: normalizedOverview,
        avgDurationText,
        statusDist,
        locationRank,
        repairerWorkload
      });
    });
  },

  extractList(res) {
    if (Array.isArray(res)) return res;
    if (res && res.list) return res.list;
    return [];
  }
});
