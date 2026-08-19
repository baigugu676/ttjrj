const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

// 柱状图绘制几何参数（绘制与点击命中共用同一份，避免两处不一致）
const BARS_GEOMETRY = { width: 320, height: 180, left: 34, right: 12, top: 20, bottom: 38 };

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
          this.measureBarsCanvas();
        }, 0);
      })
      .catch(() => this.setData({ overview: null, error: '监控状态加载失败，请重试' }))
      .finally(() => this.setData({ loading: false }));
  },

  /** 测量柱状图 canvas 的 CSS 渲染尺寸（用于把触点坐标换算回 320x180 逻辑坐标系） */
  measureBarsCanvas() {
    wx.createSelectorQuery().in(this).select('.chart').boundingClientRect((rect) => {
      this._barsRect = (rect && rect.width && rect.height) ? rect : null;
    }).exec();
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
    const { width, height, left, right, top, bottom } = BARS_GEOMETRY;
    const chart = { left, right, top, bottom };
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

  // ===== 柱状图点击：按状态跳转监控设备列表（正常/故障中/维修中） =====
  onBarsTouchStart(e) {
    const t = (e.touches && e.touches[0]) || null;
    this._barsTouchStart = t ? { x: t.x, y: t.y } : null;
  },

  onBarsTouchEnd(e) {
    const t = (e.changedTouches && e.changedTouches[0]) || null;
    const start = this._barsTouchStart;
    this._barsTouchStart = null;
    if (!t || !start) return;
    // 位移过大视为滑动（如滚动页面），不触发跳转
    if (Math.abs(t.x - start.x) + Math.abs(t.y - start.y) > 12) return;
    this.tapMonitorBar(t.x, t.y);
  },

  tapMonitorBar(touchX, touchY) {
    const rect = this._barsRect;
    const overview = this.data.overview;
    // 画布尺寸尚未测量成功（首帧布局未完成）时补测一次，本次点击忽略
    if (!rect) { this.measureBarsCanvas(); return; }
    if (!overview) return;
    const segments = Array.isArray(overview.segments) ? overview.segments : [];
    if (!segments.length) return;

    // 触点（CSS 像素）→ 320x180 逻辑坐标
    const { width, height, left, right, top, bottom } = BARS_GEOMETRY;
    const lx = touchX * width / rect.width;
    const ly = touchY * height / rect.height;
    // 仅图表区域内的点击有效
    if (lx < left || lx > width - right || ly < top || ly > height - bottom) return;

    const groupWidth = (width - left - right) / segments.length;
    const seg = segments[Math.floor((lx - left) / groupWidth)];
    if (!seg || !seg.key) return;
    wx.navigateTo({ url: '/pages/monitor/list/list?status=' + seg.key });
  },

  openMonitorList() { wx.navigateTo({ url: '/pages/monitor/list/list' }); }
});
