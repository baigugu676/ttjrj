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
    latestOrders: []      // 管理员：最新工单动态
  },

  onShow() {
    const app = getApp();
    if (!app.checkLogin()) return;
    const userInfo = app.getUserInfo() || {};
    this.setData({
      role: userInfo.role || 'user',
      userInfo
    });
    this.loadAll();
  },

  // 根据角色加载首页数据
  loadAll() {
    const role = this.data.role;
    if (role === 'user') {
      this.loadUserHome();
    } else if (role === 'repairer') {
      this.loadRepairerHome();
    } else {
      this.loadAdminHome();
    }
  },

  // 查询工单列表并返回 total（用于统计卡片数字）
  countOrders(params) {
    return api.get('/orders', Object.assign({ page: 1, pageSize: 1 }, params), { loading: false })
      .then((res) => {
        if (Array.isArray(res)) return res.length;
        return (res && res.total) || 0;
      })
      .catch(() => 0);
  },

  // 取列表数据（兼容 {list} 与裸数组）
  extractList(res) {
    if (Array.isArray(res)) return res;
    if (res && res.list) return res.list;
    return [];
  },

  // ===== 报修用户首页 =====
  loadUserHome() {
    const uid = this.data.userInfo.id;
    const ordersReq = api.get('/orders', { reporter_id: uid, page: 1, pageSize: 3 }, { loading: false }).catch(() => ({}));
    Promise.all([
      this.countOrders({ reporter_id: uid, status: 'pending_review' }),
      this.countOrders({ reporter_id: uid, status: 'pending_repair' }),
      this.countOrders({ reporter_id: uid, status: 'repairing' }),
      this.countOrders({ reporter_id: uid, status: 'completed' }),
      ordersReq
    ]).then(([pendingReview, pendingRepair, repairing, completed, ordersRes]) => {
      this.setData({
        stats: { pendingReview, pendingRepair, repairing, completed },
        recentOrders: this.extractList(ordersRes)
      });
    });
  },

  // ===== 维修人员首页 =====
  loadRepairerHome() {
    const uid = this.data.userInfo.id;
    const today = util.formatTime(new Date(), 'YYYY-MM-DD');
    const poolReq = api.get('/orders', { status: 'pending_repair', page: 1, pageSize: 3 }, { loading: false }).catch(() => ({}));
    const repairingReq = api.get('/orders', { assigned_repairer_id: uid, status: 'repairing', page: 1, pageSize: 3 }, { loading: false }).catch(() => ({}));
    const doneReq = api.get('/orders', { assigned_repairer_id: uid, status: 'completed', page: 1, pageSize: 50 }, { loading: false }).catch(() => ({}));
    Promise.all([
      this.countOrders({ status: 'pending_repair' }),
      this.countOrders({ assigned_repairer_id: uid, status: 'repairing' }),
      poolReq,
      repairingReq,
      doneReq
    ]).then(([pendingAccept, repairing, poolRes, repairingRes, doneRes]) => {
      // 今日完成数：按完成时间（end_time / updated_at）统计当天
      const doneList = this.extractList(doneRes);
      const todayCompleted = doneList.filter((o) => {
        const t = util.formatTime(o.end_time || o.updated_at || o.created_at, 'YYYY-MM-DD');
        return t === today;
      }).length;
      this.setData({
        stats: { pendingAccept, repairing, todayCompleted },
        poolOrders: this.extractList(poolRes),
        repairingOrders: this.extractList(repairingRes)
      });
    });
  },

  // ===== 管理员首页 =====
  loadAdminHome() {
    const month = util.formatTime(new Date(), 'YYYY-MM');
    const latestReq = api.get('/orders', { page: 1, pageSize: 5 }, { loading: false }).catch(() => ({}));
    const doneReq = api.get('/orders', { status: 'completed', page: 1, pageSize: 50 }, { loading: false }).catch(() => ({}));
    Promise.all([
      this.countOrders({ status: 'pending_review' }),
      this.countOrders({ status: 'pending_repair' }),
      this.countOrders({ status: 'pending_accept' }),
      latestReq,
      doneReq
    ]).then(([pendingReview, pendingRepair, pendingAccept, latestRes, doneRes]) => {
      // 本月完成数：按完成时间统计当月
      const doneList = this.extractList(doneRes);
      const monthCompleted = doneList.filter((o) => {
        const t = util.formatTime(o.end_time || o.updated_at || o.created_at, 'YYYY-MM');
        return t === month;
      }).length;
      this.setData({
        stats: { pendingReview, pendingRepair, pendingAccept, monthCompleted },
        latestOrders: this.extractList(latestRes)
      });
    });
  },

  // ===== 跳转 =====
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
      ? '/pages/admin/order-detail?id=' + id
      : '/pages/report/detail?id=' + id;
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
