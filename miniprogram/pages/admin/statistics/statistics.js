// 数据统计看板（管理员）：概览 + 状态分布 + 近30天趋势折线图 + 点位排行 + 维修工作量 + 导出CSV
// 数据字段与后端 /api/statistics/* 对齐后，统一归一化为展示字段
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: {
    overview: {},            // 归一化概览：today_new / pending / month_completed
    avgDurationText: '-',    // 平均时长展示文案
    statusDist: [],          // 状态分布 [{ status, text, color, count, percent }]
    trend: [],               // 近30天趋势 [{ date, new_count, completed_count }]
    locationRank: [],        // 点位故障排行 [{ name, count }]
    repairerWorkload: [],    // 维修人员工作量 [{ name, total, completed, repairing, pending, ... }]
    exporting: false,        // 是否导出中
    loadError: ''            // 加载失败提示
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
    this._initialLoad = true;
    this.loadAll();
  },

  onShow() {
    // 跳过首次加载（onLoad 已触发），仅从其他页面返回时刷新
    if (this._initialLoad) {
      this._initialLoad = false;
      return;
    }
    if (getApp().getRole() === 'admin') {
      this.loadAll();
    }
  },

  onPullDownRefresh() {
    this.loadAll().finally(() => wx.stopPullDownRefresh());
  },

  loadAll() {
    this.setData({ loadError: '' });
    const overviewReq = api.get('/statistics/overview', {}, { loading: false }).catch(() => ({}));
    const distReq = api.get('/statistics/status-distribution', {}, { loading: false }).catch(() => []);
    const trendReq = api.get('/statistics/trend', {}, { loading: false }).catch(() => []);
    const locReq = api.get('/statistics/location-ranking', {}, { loading: false }).catch(() => []);
    const workReq = api.get('/statistics/repairer-workload', {}, { loading: false }).catch(() => []);

    return Promise.all([overviewReq, distReq, trendReq, workReq, locReq]).then(([overview, dist, trend, workload, locRank]) => {
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

      // ---- 近30天趋势：兼容 { date, new_count, completed_count } ----
      const trendList = this.extractList(trend).map((t) => ({
        date: (t.date || '').slice(5),                    // 只保留 MM-DD 便于展示
        new_count: Number(t.new_count != null ? t.new_count : t.new) || 0,
        completed_count: Number(t.completed_count != null ? t.completed_count : t.completed) || 0
      }));

      // ---- 点位故障排行：后端返回 fault_count ----
      const locationRank = this.extractList(locRank).map((item) => ({
        name: item.name || item.location_name || '未知点位',
        count: Number(item.fault_count != null ? item.fault_count : item.count) || 0
      }));

      // ---- 维修人员工作量：归一化 total/completed/repairing/pending，并计算堆叠条比例 ----
      const repairerWorkload = this.extractList(workload).map((item) => {
        const total = Number(item.total_assigned != null ? item.total_assigned : item.count) || 0;
        const completed = Number(item.completed_count) || 0;
        const repairing = Number(item.repairing_count) || 0;
        const pending = Number(item.pending_count) || 0;
        const scale = total > 0 ? total : 1;
        return {
          name: item.real_name || item.name || item.repairer_name || '维修人员',
          total,
          completed,
          repairing,
          pending,
          completed_pct: Math.round(completed / scale * 1000) / 10,
          repairing_pct: Math.round(repairing / scale * 1000) / 10,
          pending_pct: Math.round(pending / scale * 1000) / 10
        };
      });

      this.setData({
        overview: normalizedOverview,
        avgDurationText,
        statusDist,
        trend: trendList,
        locationRank,
        repairerWorkload
      }, () => {
        // 数据就绪后绘制趋势折线图
        if (trendList.length) this.drawTrendChart(trendList);
      });
    }).catch((err) => {
      console.error('[statistics] 统计数据加载失败:', err);
      this.setData({ loadError: (err && err.message) || '统计数据加载失败，请下拉重试' });
    });
  },

  // 绘制近30天趋势折线图（新增/完成两条线；Canvas 逻辑尺寸按屏幕宽度 1:1，避免拉伸失真）
  drawTrendChart(trendList) {
    const info = wx.getSystemInfoSync();
    const width = info.windowWidth || 375;
    // 高度与 WXML 中 320rpx 完全一致（320/750），保证 1:1 不拉伸
    const height = Math.round(width * 320 / 750);
    const pad = { top: 16, right: 12, bottom: 30, left: 30 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;

    const maxVal = Math.max.apply(null, trendList.map((t) => Math.max(t.new_count, t.completed_count)).concat([1]));
    const niceMax = Math.max(4, Math.ceil(maxVal * 1.2 / 4) * 4); // 取整到 4 的倍数，留出顶部空间
    const xAt = (i) => pad.left + (trendList.length === 1 ? plotW / 2 : plotW * i / (trendList.length - 1));
    const yAt = (v) => pad.top + plotH - plotH * v / niceMax;

    const ctx = wx.createCanvasContext('trendChart', this);
    // 网格与 Y 轴刻度
    ctx.setFontSize(10);
    ctx.setFillStyle('#999999');
    const ticks = 4;
    for (let t = 0; t <= ticks; t++) {
      const v = niceMax * t / ticks;
      const y = yAt(v);
      ctx.setStrokeStyle('#EEEEEE');
      ctx.setLineWidth(1);
      ctx.beginPath();
      ctx.moveTo(pad.left, y);
      ctx.lineTo(width - pad.right, y);
      ctx.stroke();
      ctx.fillText(String(Math.round(v)), 2, y + 3);
    }
    // X 轴标签（最多 6 个，避免拥挤）
    const labelStep = Math.max(1, Math.ceil(trendList.length / 6));
    trendList.forEach((t, i) => {
      if (i % labelStep !== 0 && i !== trendList.length - 1) return;
      ctx.fillText(t.date, Math.max(0, xAt(i) - 12), height - 6);
    });

    const drawLine = (key, color) => {
      ctx.setStrokeStyle(color);
      ctx.setLineWidth(2);
      ctx.beginPath();
      trendList.forEach((t, i) => {
        const x = xAt(i);
        const y = yAt(t[key]);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      // 数据点
      ctx.setFillStyle(color);
      trendList.forEach((t, i) => {
        ctx.beginPath();
        ctx.arc(xAt(i), yAt(t[key]), 2.5, 0, Math.PI * 2);
        ctx.fill();
      });
    };
    drawLine('new_count', '#1677FF');       // 新增
    drawLine('completed_count', '#07C160'); // 完成
    ctx.draw();
  },

  // 导出统计报表 CSV：前端按已加载数据拼装 → 上传云存储 → 下载预览（可转发/另存）
  onExport() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    try {
      const rows = this.buildReportRows();
      const filename = 'statistics-' + util.formatTime(new Date(), 'YYYY-MM-DD') + '.csv';
      api.exportCsv(filename, rows).then((fileID) => new Promise((resolve, reject) => {
        wx.cloud.downloadFile({
          fileID,
          success: (d) => resolve(d.tempFilePath),
          fail: (e) => reject(new Error((e && e.errMsg) || '下载失败'))
        });
      })).then((filePath) => {
        wx.openDocument({
          filePath,
          fileType: 'csv',
          showMenu: true,
          fail: () => wx.showToast({ title: '无法预览CSV，请转发到电脑查看', icon: 'none' })
        });
      }).catch((err) => {
        wx.showToast({ title: (err && err.message) || '导出失败，请重试', icon: 'none' });
      }).finally(() => {
        this.setData({ exporting: false });
      });
    } catch (err) {
      this.setData({ exporting: false });
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    }
  },

  // 组装报表 CSV 行（概览/状态分布/趋势/排行/工作量）
  buildReportRows() {
    const rows = [];
    const ov = this.data.overview;
    rows.push(['设备报修维修统计报表', util.formatTime(new Date(), 'YYYY-MM-DD HH:mm')]);
    rows.push([]);
    rows.push(['概览']);
    rows.push(['今日新增', ov.today_new || 0]);
    rows.push(['待处理', ov.pending || 0]);
    rows.push(['本月完成', ov.month_completed || 0]);
    rows.push(['平均维修时长', this.data.avgDurationText]);
    rows.push([]);
    rows.push(['工单状态分布']);
    rows.push(['状态', '数量']);
    this.data.statusDist.forEach((d) => rows.push([d.text, d.count]));
    rows.push([]);
    rows.push(['近30天趋势']);
    rows.push(['日期', '新增', '完成']);
    this.data.trend.forEach((t) => rows.push([t.date, t.new_count, t.completed_count]));
    rows.push([]);
    rows.push(['点位故障排行 TOP10']);
    rows.push(['排名', '点位', '故障次数']);
    this.data.locationRank.forEach((l, i) => rows.push([i + 1, l.name, l.count]));
    rows.push([]);
    rows.push(['维修人员工作量']);
    rows.push(['姓名', '总指派', '已完成', '维修中', '待处理']);
    this.data.repairerWorkload.forEach((w) => rows.push([w.name, w.total, w.completed, w.repairing, w.pending]));
    return rows;
  },

  extractList(res) {
    if (Array.isArray(res)) return res;
    if (res && res.list) return res.list;
    return [];
  }
});
