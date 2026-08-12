const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: { overview: null, normalRateText: '0%', loading: true, error: '' },

  onLoad() { this.load(); },
  onPullDownRefresh() { this.load().finally(() => wx.stopPullDownRefresh()); },

  load() {
    this.setData({ loading: true, error: '' });
    return api.getMonitorOverview({ loading: false, silent: true })
      .then((overview) => {
        const data = overview || {};
        this.setData({
          overview: data,
          normalRateText: util.formatPercent(data.normalRate)
        });
        setTimeout(() => {
          this.drawDonutChart();
          this.drawMonitorBars();
        }, 0);
      })
      .catch(() => this.setData({ overview: null, error: '监控状态加载失败，请重试' }))
      .finally(() => this.setData({ loading: false }));
  },

  retry() { this.load(); },

  /** 环形占比图 —— 展示正常监控百分比 */
  drawDonutChart() {
    const overview = this.data.overview;
    if (!overview) return;

    const ctx = wx.createCanvasContext('monitorDonut', this);
    const width = 200;
    const height = 200;
    const cx = width / 2;
    const cy = height / 2;
    const radius = 66;
    const lineWidth = 16;

    const normalRate = Number(overview.normalRate) || 0;
    // Canvas arc: 0 at 3-o'clock, clockwise. Start at 12-o'clock (-PI/2).
    const startAngle = -Math.PI / 2;
    const endAngle = startAngle + (normalRate / 100) * 2 * Math.PI;

    ctx.clearRect(0, 0, width, height);

    // 底色圆环
    ctx.setLineWidth(lineWidth);
    ctx.setStrokeStyle('#e5e7eb');
    ctx.setLineCap('round');
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, 2 * Math.PI);
    ctx.stroke();

    // 正常占比弧线（绿色）
    if (normalRate > 0) {
      ctx.setStrokeStyle('#16a34a');
      ctx.beginPath();
      ctx.arc(cx, cy, radius, startAngle, endAngle);
      ctx.stroke();
    }

    // 非正常占比弧线（红色，接在绿色后面）
    if (normalRate < 100) {
      const faultStart = endAngle;
      const faultEnd = startAngle + 2 * Math.PI;
      ctx.setStrokeStyle('#ef4444');
      ctx.beginPath();
      ctx.arc(cx, cy, radius, faultStart, faultEnd);
      ctx.stroke();
    }

    ctx.draw();
  },

  /** 状态分布柱状图 */
  drawMonitorBars() {
    const overview = this.data.overview;
    if (!overview) return;
    const ctx = wx.createCanvasContext('monitorBars', this);
    const width = 320; const height = 180;
    const chart = { left: 34, right: 12, top: 20, bottom: 38 };
    const chartWidth = width - chart.left - chart.right;
    const chartHeight = height - chart.top - chart.bottom;
    const segments = Array.isArray(overview.segments) ? overview.segments : [];
    const maxValue = Math.max(1, ...segments.map((item) => Number(item.value) || 0));
    const gridSteps = 4;

    ctx.clearRect(0, 0, width, height);
    ctx.setLineWidth(1);
    ctx.setStrokeStyle('#e5e7eb');
    ctx.setFillStyle('#9ca3af');
    ctx.setFontSize(10);
    ctx.setTextAlign('right');
    for (let step = 0; step <= gridSteps; step += 1) {
      const y = chart.top + chartHeight * step / gridSteps;
      const value = Math.round(maxValue * (gridSteps - step) / gridSteps);
      ctx.beginPath(); ctx.moveTo(chart.left, y); ctx.lineTo(width - chart.right, y); ctx.stroke();
      ctx.fillText(String(value), chart.left - 7, y + 3);
    }

    const groupWidth = chartWidth / Math.max(segments.length, 1);
    const barWidth = Math.min(42, groupWidth * 0.48);
    ctx.setTextAlign('center');
    segments.forEach((item, index) => {
      const value = Number(item.value) || 0;
      const barHeight = value / maxValue * chartHeight;
      const x = chart.left + groupWidth * index + (groupWidth - barWidth) / 2;
      const y = chart.top + chartHeight - barHeight;
      ctx.setFillStyle(item.color || '#07c160');
      ctx.fillRect(x, y, barWidth, barHeight);
      ctx.setFillStyle('#374151');
      ctx.setFontSize(11);
      ctx.fillText(String(value), x + barWidth / 2, Math.max(chart.top - 4, y - 7));
      ctx.setFillStyle('#6b7280');
      ctx.setFontSize(10);
      ctx.fillText(item.label || '', x + barWidth / 2, height - 15);
    });
    ctx.draw();
  },

  openMonitorList() { wx.navigateTo({ url: '/pages/monitor/list/list' }); }
});
