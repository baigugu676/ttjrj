// 我的维修任务（维修人员）：维修中 / 待验收 / 已完成 / 今日完成 / 退回返修 / 挂起
// 支持：进入维修、转交给其他维修人员、挂起（当天未修完）与恢复
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: {
    tabs: [
      { label: '维修中', value: 'repairing' },
      { label: '待验收', value: 'pending_accept' },
      { label: '已完成', value: 'completed' },
      { label: '今日完成', value: 'today_completed' },
      { label: '退回返修', value: 'repair_returned' },
      { label: '挂起', value: 'suspended' }
    ],
    tab: 'repairing',   // 当前筛选状态
    list: [],
    page: 1,
    pageSize: 10,
    hasMore: true,
    loading: false,
    // 转交弹窗
    showTransfer: false,
    repairers: [],        // 可转交的维修人员
    repairerNames: [],    // picker 展示文案
    transferIndex: -1,
    transferOrderId: '',
    transferReason: '',
    transfering: false,
    actionId: ''          // 正在执行挂起/恢复/转交的工单 id
  },

  onLoad(options) {
    const app = getApp();
    if (!app.checkLogin()) return;
    // 角色权限控制：仅维修人员可访问
    if (!util.guardRole('repairer')) return;
    // 支持从首页或其他入口预设 tab（URL 参数优先，其次 Storage）
    const presetTab = (options && options.tab) || wx.getStorageSync('mytasksTab') || '';
    if (presetTab) {
      this.setData({ tab: presetTab });
      wx.removeStorageSync('mytasksTab');
    }
    this._initialLoad = true;
    this.loadList(true);
    this.loadRepairers();
  },

  onShow() {
    // 从维修执行页返回时刷新（空列表也刷新，避免状态已变化的工单停留旧数据）；
    // 首次进入跳过（onLoad 已触发），避免首屏重复请求
    if (this._initialLoad) {
      this._initialLoad = false;
      return;
    }
    if (getApp().getRole() === 'repairer') {
      this.loadList(true);
    }
  },

  // 返回首页（本页由「工单」tab reLaunch 进入，tabBar 不可见，需提供出口）
  goHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },

  onTabChange(e) {
    const value = e.currentTarget.dataset.value;
    if (value === this.data.tab) return;
    this.setData({ tab: value });
    this.loadList(true);
  },

  loadList(reset) {
    const { page, pageSize, hasMore, loading } = this.data;
    if (!reset && (!hasMore || loading)) return;
    const target = reset ? 1 : page + 1;
    this.setData({ loading: true });

    // 今日完成：服务端按 completed 查询，客户端再按日期过滤
    const apiStatus = this.data.tab === 'today_completed' ? 'completed' : this.data.tab;

    api.get('/orders', {
      assigned_repairer_id: this.getMyId(),
      status: apiStatus,
      completed_today: this.data.tab === 'today_completed' ? 1 : 0,
      page: target,
      pageSize
    }, { loading: false }).then((res) => {
      const rows = util.extractList(res);

      this.setData({
        list: reset ? rows : this.data.list.concat(rows),
        page: target,
        hasMore: rows.length >= pageSize,
        loading: false
      });
    }).catch((err) => {
      console.error('[mytasks] 加载任务列表失败:', err);
      this.setData({ loading: false });
      wx.showToast({ title: (err && err.message) || '任务列表加载失败', icon: 'none' });
    }).finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  getMyId() {
    const app = getApp();
    const info = app.getUserInfo() || {};
    return info.id;
  },

  // 加载可转交的维修人员（排除本人由调用侧过滤）
  loadRepairers() {
    api.getRepairerOptions({ loading: false, silent: true }).then((res) => {
      const list = util.extractList(res);
      const myId = this.getMyId();
      const others = list.filter((u) => String(u.id) !== String(myId));
      this.setData({
        repairers: others,
        repairerNames: others.map((u) => util.getRepairerLabel(u))
      });
    }).catch((err) => {
      console.error('[mytasks] 加载维修人员列表失败:', err);
    });
  },

  onPullDownRefresh() {
    this.loadList(true);
  },

  onReachBottom() {
    this.loadList(false);
  },

  // 点击工单卡片查看详情（order-card 的 select 事件）
  goDetail(e) {
    const id = e.detail && e.detail.id;
    if (id) wx.navigateTo({ url: '/pages/report/detail/detail?id=' + id });
  },

  // 查看工单详情（通过 data-id 传参）
  goDetailById(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/report/detail/detail?id=' + id });
  },

  // 进入维修执行页（维修中/退回返修状态下可用）
  goExecute(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: '/pages/repair/execute/execute?id=' + id });
  },

  // ===== 挂起 / 恢复 =====
  doSuspend(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.actionId) return;
    wx.showModal({
      title: '挂起工单',
      editable: true,
      placeholderText: '挂起原因（选填），如：等待配件',
      confirmText: '确认挂起',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ actionId: id });
        api.put('/orders/' + id + '/suspend', {
          reason: (res.content || '').trim()
        }, { silent: true }).then(() => {
          wx.showToast({ title: '已挂起', icon: 'success' });
          this.loadList(true);
        }).catch((err) => {
          wx.showToast({ title: (err && err.message) || '挂起失败，请重试', icon: 'none' });
        }).finally(() => this.setData({ actionId: '' }));
      }
    });
  },

  doResume(e) {
    const id = e.currentTarget.dataset.id;
    if (!id || this.data.actionId) return;
    wx.showModal({
      title: '恢复维修',
      content: '确认恢复该工单并继续维修？',
      confirmText: '确认恢复',
      confirmColor: '#07C160',
      success: (res) => {
        if (!res.confirm) return;
        this.setData({ actionId: id });
        api.put('/orders/' + id + '/resume', {}, { silent: true }).then(() => {
          wx.showToast({ title: '已恢复维修', icon: 'success' });
          // 恢复后切回「维修中」tab，便于直接进入维修
          this.setData({ tab: 'repairing' });
          this.loadList(true);
        }).catch((err) => {
          wx.showToast({ title: (err && err.message) || '恢复失败，请重试', icon: 'none' });
        }).finally(() => this.setData({ actionId: '' }));
      }
    });
  },

  // ===== 转交 =====
  openTransfer(e) {
    const id = e.currentTarget.dataset.id;
    if (!id) return;
    if (!this.data.repairers.length) {
      this.loadRepairers();
      wx.showToast({ title: '暂无其他维修人员可转交', icon: 'none' });
      return;
    }
    this.setData({
      showTransfer: true,
      transferOrderId: id,
      transferIndex: -1,
      transferReason: ''
    });
  },

  closeTransfer() {
    if (this.data.transfering) return;
    this.setData({ showTransfer: false, transferIndex: -1, transferReason: '' });
  },

  onTransferRepairerChange(e) {
    this.setData({ transferIndex: Number(e.detail.value) });
  },

  onTransferReasonInput(e) {
    this.setData({ transferReason: e.detail.value });
  },

  confirmTransfer() {
    const { transferIndex, repairers, transferOrderId, transferReason, transfering } = this.data;
    if (transfering) return;
    if (transferIndex < 0) {
      wx.showToast({ title: '请选择接收的维修人员', icon: 'none' });
      return;
    }
    const target = repairers[transferIndex];
    if (!target || !target.id) {
      wx.showToast({ title: '请重新选择维修人员', icon: 'none' });
      return;
    }
    this.setData({ transfering: true });
    api.put('/orders/' + transferOrderId + '/transfer', {
      target_repairer_id: target.id,
      reason: transferReason.trim()
    }, { silent: true }).then(() => {
      wx.showToast({ title: '转交成功', icon: 'success' });
      this.setData({ showTransfer: false, transferIndex: -1, transferReason: '' });
      this.loadList(true);
    }).catch((err) => {
      wx.showToast({ title: (err && err.message) || '转交失败，请重试', icon: 'none' });
    }).finally(() => this.setData({ transfering: false }));
  },

  noop() {}
});
