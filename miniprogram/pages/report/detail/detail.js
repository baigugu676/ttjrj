// 报修工单详情：基本信息 + 照片 + 时间线
const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

Page({
  data: {
    id: '',
    order: null,
    statusText: '',
    steps: [],            // 时间线步骤
    reportImages: [],     // 报修照片
    repairInfo: null      // 维修记录（含维修前后照片）
  },

  onLoad(options) {
    const app = getApp();
    if (!app.checkLogin()) return;
    this.setData({ id: options.id });
    this.loadDetail();
  },

  onPullDownRefresh() {
    this.loadDetail().finally(() => wx.stopPullDownRefresh());
  },

  loadDetail() {
    return api.get('/orders/' + this.data.id, {}, { loading: false }).then((order) => {
      const images = util.splitImages(order);
      const repair = order.repair_record || order.repairRecord || null;
      // 为字段做展示兜底
      if (order) {
        order.created_at_text = util.formatTime(order.created_at || order.createdAt);
      }
      if (repair) {
        repair.start_time_text = util.formatTime(repair.start_time);
        repair.gps_text = (repair.gps_latitude && repair.gps_longitude) ?
          '纬度' + repair.gps_latitude + '，经度' + repair.gps_longitude : '';
        repair.repairer_name = repair.repairer_name || order.repairer_name || '';
      }
      this.setData({
        order,
        statusText: util.getStatusText(order.status),
        steps: util.buildTimelineSteps(order),
        reportImages: images.report,
        repairInfo: repair
      });
      wx.setNavigationBarTitle({
        title: order.order_no ? ('工单 ' + order.order_no) : '报修详情'
      });
    }).catch(() => {});
  },

  // 预览报修照片
  previewReport(e) {
    const { index } = e.currentTarget.dataset;
    util.previewImages(this.data.reportImages, index);
  }
});
