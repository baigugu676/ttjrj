// 工单管理（管理员）：状态筛选 + 搜索 + 按状态显示操作按钮（审核/验收/查看）
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

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
      { label: '已完成', value: 'completed' },
      { label: '已驳回', value: 'rejected' },
      { label: '退回返修', value: 'repair_returned' }
    ],
    status: '',       // 当前筛选状态
    keyword: '',      // 搜索关键字
    list: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    exporting: false  // 是否导出中
  },

  onLoad(options) {
    const app = getApp();
    if (!app.checkLogin()) return;
    // 角色权限控制：仅管理员可访问
    if (!util.guardRole('admin')) return;
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

  // 返回首页（本页由「工单」tab reLaunch 进入，tabBar 不可见，需提供出口）
  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  // 导出当前筛选条件下的工单 CSV（云端生成后下载预览，可转发/另存）
  onExport() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    api.callCloud('orders', {
      action: 'exportCsv',
      status: this.data.status,
      keyword: this.data.keyword.trim(),
      _token: wx.getStorageSync('token') || ''
    }, { loading: true, loadingText: '正在生成...' }).then((res) => {
      const fileID = res && res.fileID;
      if (!fileID) throw new Error('导出失败：未返回文件');
      return new Promise((resolve, reject) => {
        wx.cloud.downloadFile({
          fileID,
          success: (d) => resolve(d.tempFilePath),
          fail: (e) => reject(new Error((e && e.errMsg) || '下载失败'))
        });
      });
    }).then((filePath) => {
      wx.openDocument({
        filePath,
        fileType: 'csv',
        showMenu: true, // 允许转发/保存
        fail: () => wx.showToast({ title: '无法预览CSV，请转发到电脑查看', icon: 'none' })
      });
    }).catch((err) => {
      wx.showToast({ title: (err && err.message) || '导出失败，请重试', icon: 'none' });
    }).finally(() => {
      this.setData({ exporting: false });
    });
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
      const rows = this.decorate(util.extractList(res));
      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch((err) => {
      console.error('[admin/orders] 加载工单列表失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: (err && err.message) || '工单列表加载失败', icon: 'none' });
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

  onPullDownRefresh() {
    this.loadList(true);
  },

  onReachBottom() {
    this.loadList(false);
  },

  // 操作按钮：全部进入工单详情（审核/验收在详情页进行）
  doAction(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/admin/order-detail/order-detail?id=' + id });
  },

  // 点击行查看详情
  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/admin/order-detail/order-detail?id=' + id });
  }
});
