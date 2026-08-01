// 我的报修列表：状态筛选 tab + 下拉刷新 + 上拉加载更多
// 说明：此页是 TabBar 的「工单」页。维修人员进入时重定向到我的维修任务，
//       管理员进入时重定向到工单管理（见分工文档 §2 app.json 要点）
const api = require('../../../utils/api.js');

Page({
  data: {
    statusTabs: [
      { label: '全部', value: '' },
      { label: '待审核', value: 'pending_review' },
      { label: '待维修', value: 'pending_repair' },
      { label: '维修中', value: 'repairing' },
      { label: '待验收', value: 'pending_accept' },
      { label: '已完成', value: 'completed' }
    ],
    status: '',       // 当前筛选状态
    list: [],         // 工单列表
    page: 1,          // 当前页码
    pageSize: 10,     // 每页条数
    total: 0,         // 总条数
    hasMore: true,    // 是否还有更多
    loading: false    // 是否加载中
  },

  onShow() {
    const app = getApp();
    if (!app.checkLogin()) return;

    // 根据角色重定向（分工文档：维修人员工单tab指向 mytasks）
    const role = app.getRole();
    if (role === 'repairer') {
      wx.reLaunch({ url: '/pages/repair/mytasks/mytasks' });
      return;
    }
    if (role === 'admin') {
      wx.reLaunch({ url: '/pages/admin/orders/orders' });
      return;
    }

    // 读取首页统计卡片传来的状态筛选参数
    const savedStatus = wx.getStorageSync('listStatus');
    if (savedStatus !== '' && savedStatus !== undefined && savedStatus !== null) {
      wx.removeStorageSync('listStatus');
      if (String(savedStatus) !== String(this.data.status)) {
        this.setData({ status: String(savedStatus) });
        this.loadList(true);
        return;
      }
    }
    this.loadList(true);
  },

  // 切换状态筛选
  onTabChange(e) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.status) return;
    this.setData({ status: value });
    this.loadList(true);
  },

  // 加载工单列表
  loadList(reset) {
    const { page, pageSize, hasMore, loading } = this.data;
    if (!reset && (!hasMore || loading)) return;
    const target = reset ? 1 : page + 1;
    this.setData({ loading: true });
    api.get('/orders', {
      reporter_id: this.getMyId(),
      status: this.data.status,
      page: target,
      pageSize
    }, { loading: false }).then((res) => {
      const rows = this.extractList(res);
      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        total: (res && res.total) || rows.length,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch(() => {
      this.setData({ loading: false });
    }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  getMyId() {
    const app = getApp();
    const info = app.getUserInfo() || {};
    return info.id;
  },

  // 兼容 {list,total} 与裸数组两种返回
  extractList(res) {
    if (Array.isArray(res)) return res;
    if (res && res.list) return res.list;
    return [];
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.loadList(true);
  },

  // 上拉加载更多
  onReachBottom() {
    this.loadList(false);
  },

  // 点击卡片跳转详情
  goDetail(e) {
    wx.navigateTo({ url: '/pages/report/detail/detail?id=' + e.detail.id });
  }
});
