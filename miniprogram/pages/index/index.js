// 首页：根据角色（user / repairer / admin）动态加载统计与列表
const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

Page({
  data: {
    role: 'user',
    userInfo: {},
    stats: {},            // 各角色统计数字
    recentOrders: [],     // 报修用户：最近3条报修
    poolOrders: [],       // 维修人员：待接单预览
    repairingOrders: [],  // 维修人员：维修中预览
    latestOrders: [],     // 管理员：最新工单动态
    monitorOverview: null, // 管理员：监控状态概览
    monitorRateText: '0%',
    homeDonutSize: 80,
    loading: false,
    loadError: ''
  },

  onShow() {
    const app = getApp();
    if (!app.checkLogin()) return;
    const userInfo = app.getUserInfo() || {};
    this.setData({
      role: userInfo.role || 'user',
      userInfo,
      homeDonutSize: this.getHomeDonutSize()
    });
    this.loadAll();
  },

  getHomeDonutSize() {
    const info = wx.getSystemInfoSync();
    return Math.max(64, Math.round((info.windowWidth || 375) * 160 / 750));
  },

  // 根据角色加载首页数据：有 30 秒缓存时先秒开渲染，再后台静默刷新
  loadAll() {
    const role = this.data.role;
    const cached = this.getCachedDashboard(role);
    if (cached) {
      this.applyDashboard(cached, role);
      this.setData({ loading: false, loadError: "" });
    } else {
      this.setData({ loading: true, loadError: "" });
    }
    if (role === 'user') {
      this.loadUserHome();
    } else if (role === 'repairer') {
      this.loadRepairerHome();
    } else {
      this.loadAdminHome();
    }
  },

  // 首页看板缓存（页面实例内 30 秒有效，切 tab 返回时先展示旧数据）
  getCachedDashboard(role) {
    const cache = this._dashboardCache;
    if (!cache || cache.role !== role) return null;
    if (Date.now() - cache.time > 30000) return null;
    return cache.data;
  },

  setCachedDashboard(role, data) {
    this._dashboardCache = { role, time: Date.now(), data };
  },

  applyDashboard(dashboard, role) {
    if (!dashboard) return;
    if (role === 'user') {
      this.setData({
        stats: dashboard.stats || {},
        recentOrders: dashboard.recentOrders || []
      });
    } else if (role === 'repairer') {
      this.setData({
        stats: dashboard.stats || {},
        poolOrders: dashboard.poolOrders || [],
        repairingOrders: dashboard.repairingOrders || []
      });
    } else {
      const monitorOv = dashboard.monitorOverview;
      this.setData({
        stats: dashboard.stats || {},
        latestOrders: dashboard.latestOrders || [],
        monitorOverview: monitorOv || null,
        monitorRateText: util.formatPercent(monitorOv && monitorOv.normalRate)
      });
      if (monitorOv) setTimeout(() => this.drawHomeMonitorDonut(), 100);
    }
  },

  // ===== 报修用户首页 =====
  loadUserHome() {
    api.getDashboard({ loading: false, silent: true }).then((dashboard) => {
      this.setCachedDashboard('user', dashboard);
      this.applyDashboard(dashboard, 'user');
    }).catch((err) => this.handleLoadError(err)).finally(() => this.finishLoad());
  },

  // ===== 维修人员首页 =====
  loadRepairerHome() {
    api.getDashboard({ loading: false, silent: true }).then((dashboard) => {
      this.setCachedDashboard('repairer', dashboard);
      this.applyDashboard(dashboard, 'repairer');
    }).catch((err) => this.handleLoadError(err)).finally(() => this.finishLoad());
  },

  // ===== 管理员首页 =====
  loadAdminHome() {
    api.getDashboard({ loading: false, silent: true }).then((dashboard) => {
      this.setCachedDashboard('admin', dashboard);
      this.applyDashboard(dashboard, 'admin');
    }).catch((err) => this.handleLoadError(err)).finally(() => this.finishLoad());
  },

  finishLoad() { this.setData({ loading: false }); wx.stopPullDownRefresh(); },
  handleLoadError(err) {
    console.error('[index] 首页加载失败:', err);
    if (this.getCachedDashboard(this.data.role)) return;
    this.setData({ loadError: (err && err.message) || '首页数据加载失败，请重试' });
  },
  retryLoad() { this.loadAll(); },
  onPullDownRefresh() { this.loadAll(); },

  // ===== 跳转 =====
  openMonitorOverview() {
    wx.navigateTo({ url: '/pages/monitor/overview/overview' });
  },

  /** 管理员首页 —— 监控环形占比图 */
  drawHomeMonitorDonut() {
    const overview = this.data.monitorOverview;
    if (!overview) return;

    const ctx = wx.createCanvasContext('homeMonitorDonut', this);
    const width = this.data.homeDonutSize;
    const height = this.data.homeDonutSize;
    const cx = width / 2;
    const cy = height / 2;
    const radius = width * 0.3375;
    const lineWidth = Math.max(5, width * 0.075);

    const normalRate = Math.max(0, Math.min(100, Number(overview.normalRate) || 0));
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

    // 非正常占比弧线（红色）
    if (normalRate < 100) {
      ctx.setStrokeStyle('#ef4444');
      ctx.beginPath();
      ctx.arc(cx, cy, radius, endAngle, startAngle + 2 * Math.PI);
      ctx.stroke();
    }

    // 中心百分比数字
    ctx.setFillStyle('#16a34a');
    ctx.setFontSize(17);
    ctx.setTextAlign('center');
    ctx.setTextBaseline('middle');
    const displayRate = parseFloat(normalRate.toFixed(1));
    ctx.fillText(displayRate + '%', cx, cy - 2);

    // 中心副标题
    ctx.setFillStyle('#9ca3af');
    ctx.setFontSize(9);
    ctx.fillText('正常率', cx, cy + 14);

    ctx.draw();
  },

  // 报修用户：新建报修
  goCreate() {
    wx.navigateTo({ url: '/pages/report/create/create' });
  },

  // 报修用户：按状态查看我的报修（工单tab是 tabBar 页面，通过 Storage 传参）
  goList(e) {
    const status = e.currentTarget.dataset.status || '';
    wx.setStorageSync('listStatus', status);
    wx.switchTab({ url: '/pages/report/list/list' });
  },

  // 工单详情（根据角色跳转不同详情页）
  goDetail(e) {
    const id = e.detail.id;
    const url = this.data.role === 'admin'
      ? '/pages/admin/order-detail/order-detail?id=' + id
      : '/pages/report/detail/detail?id=' + id;
    wx.navigateTo({ url });
  },

  // 维修人员：待接单工单池
  goPool() {
    wx.navigateTo({ url: '/pages/repair/pool/pool' });
  },

  // 维修人员：我的维修任务
  goMyTasks() {
    wx.navigateTo({ url: '/pages/repair/mytasks/mytasks' });
  },

  // 维修人员：今日完成（跳转 mytasks 并预设 today_completed tab）
  goMyTasksToday() {
    wx.setStorageSync('mytasksTab', 'today_completed');
    wx.navigateTo({ url: '/pages/repair/mytasks/mytasks' });
  },

  // 维修人员：挂起工单（跳转 mytasks 并预设 suspended tab）
  goMyTasksSuspended() {
    wx.setStorageSync('mytasksTab', 'suspended');
    wx.navigateTo({ url: '/pages/repair/mytasks/mytasks' });
  },

  // 管理员：工单管理（按状态筛选）
  goAdminOrders(e) {
    const status = (e.currentTarget.dataset && e.currentTarget.dataset.status) || '';
    wx.navigateTo({ url: '/pages/admin/orders/orders?status=' + status });
  },

  // 管理员：用户管理
  goUsers() {
    wx.navigateTo({ url: '/pages/admin/users/users' });
  },

  // 管理员：数据统计
  goStats() {
    wx.navigateTo({ url: '/pages/admin/statistics/statistics' });
  },

  // 管理员：点位管理
  goLocations() {
    wx.navigateTo({ url: '/pages/admin/locations/locations' });
  }
});
