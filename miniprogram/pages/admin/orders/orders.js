// 工单管理（管理员）：状态筛选 + 搜索 + 按状态显示操作按钮（审核/验收/查看）
const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

// 操作按钮文案映射
const ACTION_MAP = {
  pending_review: { text: '审核', cls: 'btn-approve' },
  pending_repair: { text: '查看', cls: 'btn-view' },
  repairing: { text: '查看', cls: 'btn-view' },
  pending_accept: { text: '验收', cls: 'btn-verify' },
  completed: { text: '详情', cls: 'btn-view' },
  rejected: { text: '详情', cls: 'btn-view' },
  repair_returned: { text: '详情', cls: 'btn-view' }
};

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
    keyword: '',      // 搜索关键字
    list: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false
  },

  onLoad(options) {
    const app = getApp();
    if (!app.checkLogin()) return;
    // 角色权限控制：仅管理员可访问
    if (app.getRole() !== 'admin') {
      wx.showToast({ title: '仅管理员可访问', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1000);
      return;
    }
    // 支持从首页快捷入口带入状态筛选
    if (options && options.status) {
      this.setData({ status: options.status });
    }
  },

  onShow() {
    // 从详情页返回时刷新
    if (getApp().getRole() === 'admin') {
      this.loadList(true);
    }
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    this.loadList(true);
  },

  onTabChange(e) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.status) return;
    this.setData({ status: value });
    this.loadList(true);
  },

  loadList(reset) {
    const { page, pageSize, hasMore, loading } = this.data;
    if (!reset && (!hasMore || loading)) return;
    const target = reset ? 1 : page + 1;
    this.setData({ loading: true });
    api.get('/orders', {
      status: this.data.status,
      keyword: this.data.keyword.trim(),
      page: target,
      pageSize
    }, { loading: false }).then((res) => {
      const rows = this.decorate(this.extractList(res));
      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch(() => {
      this.setData({ loading: false });
    }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 补充展示字段（状态文案、操作按钮）
  decorate(rows) {
    return rows.map((o) => {
      const action = ACTION_MAP[o.status] || { text: '详情', cls: 'btn-view' };
      return Object.assign({}, o, {
        status_text: util.getStatusText(o.status),
        created_at_text: util.formatTime(o.created_at),
        action_text: action.text,
        action_btn_class: action.cls
      });
    });
  },

  extractList(res) {
    if (Array.isArray(res)) return res;
    if (res && res.list) return res.list;
    return [];
  },

  onPullDownRefresh() {
    this.loadList(true);
  },

  onReachBottom() {
    this.loadList(false);
  },

  // 操作按钮：全部进入工单详情（审核/验收在详情页进行）
  doAction(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/admin/order-detail?id=' + id });
  },

  // 点击行查看详情
  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/admin/order-detail?id=' + id });
  }
});
