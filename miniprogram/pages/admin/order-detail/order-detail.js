// 工单详情（管理员）：完整展示报修/审核/维修信息，维修前后对比，审核与验收操作
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: {
    id: '',
    order: null,
    statusText: '',
    steps: [],
    reportImages: [],     // 报修照片
    beforeImages: [],     // 维修前照片
    afterImages: [],      // 维修后照片
    repairInfo: null,     // 维修记录
    reporterName: '',     // 报修人姓名
    repairers: [],        // 可指派的维修人员列表
    repairerNames: [],    // 维修人员姓名（picker 展示）
    repairerIndex: -1,    // 选中的维修人员下标
    loadError: false      // 加载失败状态
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
    this.setData({ id: options.id, repairerIndex: -1 });
    this.loadDetail();
    this.loadRepairers();
  },

  onPullDownRefresh() {
    this.loadDetail().finally(() => wx.stopPullDownRefresh());
  },

  // 加载工单详情
  loadDetail() {
    this.setData({ loadError: false });
    return api.get('/orders/' + this.data.id, {}, { loading: false }).then((order) => {
      const images = util.splitImages(order);
      const repair = util.getRepairRecord(order);
      const accept = util.getAcceptanceRecord(order);
      order.created_at_text = util.formatTime(order.created_at || order.createdAt);
      order.reviewed_at_text = util.formatTime(order.reviewed_at);
      if (repair) {
        repair.start_time_text = util.formatTime(repair.start_time);
        repair.end_time_text = util.formatTime(repair.end_time);
      }
      this.setData({
        order,
        statusText: util.getStatusText(order.status),
        steps: util.buildTimelineSteps(order),
        reportImages: images.report,
        beforeImages: images.before,
        afterImages: images.after,
        repairInfo: repair,
        reporterName: order.reporter_name || order.reporter_real_name || '未知',
        acceptRecord: accept
      });
      wx.setNavigationBarTitle({
        title: order.order_no ? ('工单 ' + order.order_no) : '工单详情'
      });
    }).catch((err) => {
      console.error('[order-detail] 加载工单详情失败:', err);
      // 失败可重试，不永久停留在加载中
      this.setData({ loadError: true });
    });
  },

  // 加载维修人员列表（审核通过时需指派）
  loadRepairers() {
    api.get('/users', { role: 'repairer', page: 1, pageSize: 100 }, { loading: false }).then((res) => {
      const list = Array.isArray(res) ? res : ((res && res.list) || []);
      this.setData({
        repairers: list,
        repairerNames: list.map((u) => u.real_name || u.username || ('维修员' + u.id))
      });
    }).catch((err) => { console.error('[order-detail] 加载维修人员列表失败:', err); });
  },

  onRepairerChange(e) {
    this.setData({ repairerIndex: Number(e.detail.value) });
  },

  // ===== 审核操作 =====
  doReview(e) {
    const action = e.currentTarget.dataset.action;
    if (action === 'approve') {
      // 通过：必须指派维修人员
      if (this.data.repairerIndex < 0) {
        wx.showToast({ title: '请先选择指派的维修人员', icon: 'none' });
        return;
      }
      wx.showModal({
        title: '审核通过',
        content: '确认审核通过并指派维修人员？',
        confirmColor: '#07C160',
        success: (res) => {
          if (!res.confirm) return;
          const repairer = this.data.repairers[this.data.repairerIndex];
          this.reviewSubmit({ action: 'approve', assigned_repairer_id: repairer.id });
        }
      });
    } else {
      // 驳回：要求填写驳回原因
      wx.showModal({
        title: '驳回工单',
        editable: true,
        placeholderText: '请填写驳回原因（必填）',
        confirmText: '确认驳回',
        confirmColor: '#FA5151',
        success: (res) => {
          if (!res.confirm) return;
          const reason = (res.content || '').trim();
          if (!reason) {
            wx.showToast({ title: '请填写驳回原因', icon: 'none' });
            return;
          }
          this.reviewSubmit({ action: 'reject', reject_reason: reason });
        }
      });
    }
  },

  reviewSubmit(data) {
    api.put('/orders/' + this.data.id + '/review', data).then(() => {
      wx.showToast({ title: '操作成功', icon: 'success' });
      this.loadDetail();
    }).catch((err) => {
      console.error('[order-detail] 审核提交失败:', err);
      wx.showToast({ title: (err && err.message) || '审核操作失败', icon: 'none' });
    });
  },

  // ===== 验收操作 =====
  doAccept(e) {
    const action = e.currentTarget.dataset.action;
    if (action === 'pass') {
      wx.showModal({
        title: '验收通过',
        content: '确认设备维修验收通过并归档？',
        confirmColor: '#07C160',
        success: (res) => {
          if (!res.confirm) return;
          this.acceptSubmit({ action: 'pass' });
        }
      });
    } else {
      wx.showModal({
        title: '退回维修',
        editable: true,
        placeholderText: '请填写退回原因（必填）',
        confirmText: '确认退回',
        confirmColor: '#FA5151',
        success: (res) => {
          if (!res.confirm) return;
          const reason = (res.content || '').trim();
          if (!reason) {
            wx.showToast({ title: '请填写退回原因', icon: 'none' });
            return;
          }
          this.acceptSubmit({ action: 'return', return_reason: reason });
        }
      });
    }
  },

  acceptSubmit(data) {
    api.put('/orders/' + this.data.id + '/accept', data).then(() => {
      wx.showToast({ title: '操作成功', icon: 'success' });
      this.loadDetail();
    }).catch((err) => {
      console.error('[order-detail] 验收提交失败:', err);
      wx.showToast({ title: (err && err.message) || '验收操作失败', icon: 'none' });
    });
  },

  // 预览照片
  previewReport(e) {
    const { index } = e.currentTarget.dataset;
    util.previewImages(this.data.reportImages, index);
  },

  previewCompare(e) {
    const { key, index } = e.currentTarget.dataset;
    util.previewImages(this.data[key], index);
  }
});
