// 维修执行页（核心页面）：维修前拍照 → 维修时间 → GPS定位 → 故障原因 → 维修措施 → 维修后拍照 → OK上线
// 提交逻辑：
//   1. 上传维修前/后照片（order_id + image_type: repair_before / repair_after）
//   2. 调用 PUT /api/orders/:id/repair 提交维修记录
//   3. 成功后跳转回任务列表
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: {
    id: '',
    order: null,
    statusText: '',
    reportImages: [],     // 报修照片（只读）
    beforeImages: [],     // 维修前照片（仅拍照）
    afterImages: [],      // 维修后照片（仅拍照）
    repairDate: '',       // 维修日期（默认当天）
    repairTime: '',       // 维修时间（默认当前时间）
    locating: false,      // 是否定位中
    gpsText: '',          // GPS 坐标展示文本
    gpsLatitude: '',      // 纬度
    gpsLongitude: '',     // 经度
    locationAddress: '',  // 地址描述
    faultReason: '',      // 故障原因
    repairAction: '',     // 维修措施
    submitting: false,    // 是否提交中
    loadError: false,     // 工单加载失败
    uploadProgress: ''    // 照片上传进度提示
  },

  onLoad(options) {
    const app = getApp();
    if (!app.checkLogin()) return;
    // 角色权限控制：仅维修人员可访问
    if (app.getRole() !== 'repairer') {
      wx.showToast({ title: '仅维修人员可访问', icon: 'none' });
      setTimeout(() => wx.switchTab({ url: '/pages/index/index' }), 1000);
      return;
    }
    // 默认维修时间为当前时间，并强制复位提交状态（防止热重载保留旧状态）
    const now = new Date();
    this.setData({
      id: options.id,
      submitting: false,
      repairDate: util.formatTime(now, 'YYYY-MM-DD'),
      repairTime: util.formatTime(now, 'HH:mm')
    });
    this.loadOrder();
  },

  // 加载工单信息
  loadOrder() {
    this.setData({ loadError: false });
    api.get('/orders/' + this.data.id, {}, { loading: false }).then(async (order) => {
      const images = util.splitImages(order);
      this.setData({
        order,
        statusText: util.getStatusText(order.status),
        reportImages: images.report
      });
      wx.setNavigationBarTitle({
        title: order.order_no ? ('维修 ' + order.order_no) : '维修执行'
      });
      // 兜底：若工单仍是"待维修"状态（未接单），先自动接单
      if (order.status === 'pending_repair') {
        await this.autoAcceptRepair();
      }
      // 进入页面自动尝试定位
      this.getLocation();
    }).catch((err) => {
      console.error('[execute] 加载工单失败:', err);
      // 失败可重试，不永久停留在加载中
      this.setData({ loadError: true });
    });
  },

  // 自动接单（await 确保接单完成后再允许提交；失败则提示用户刷新重试）
  async autoAcceptRepair() {
    try {
      await api.put('/orders/' + this.data.id + '/accept-repair', {}, { silent: true });
    } catch (err) {
      // 接单失败：刷新页面状态以确认当前订单是否可操作
      const msg = (err && err.message) || '接单失败';
      wx.showToast({ title: msg + '，请下拉刷新重试', icon: 'none', duration: 2500 });
    }
  },

  // ===== 步骤1/6：拍照（只能拍照） =====
  takePhoto(e) {
    const type = e.currentTarget.dataset.type; // before / after
    const key = type === 'before' ? 'beforeImages' : 'afterImages';
    const list = this.data[key];
    const count = 9 - list.length;
    if (count <= 0) {
      wx.showToast({ title: '最多9张', icon: 'none' });
      return;
    }
    // wx.chooseMedia 替代已废弃的 wx.chooseImage
    wx.chooseMedia({
      count,
      mediaType: ['image'],
      sizeType: ['compressed'],
      sourceType: ['camera'], // 只能调用相机拍照
      success: (res) => {
        const paths = (res.tempFiles || []).map((f) => f.tempFilePath).filter(Boolean);
        this.setData({ [key]: list.concat(paths) });
      }
    });
  },

  // 删除照片
  deletePhoto(e) {
    const { key, index } = e.currentTarget.dataset;
    const arr = this.data[key].slice();
    arr.splice(index, 1);
    this.setData({ [key]: arr });
  },

  // 预览本地照片
  previewLocal(e) {
    const { key, index } = e.currentTarget.dataset;
    util.previewImages(this.data[key], index);
  },

  // 预览报修照片
  previewReport(e) {
    const { index } = e.currentTarget.dataset;
    util.previewImages(this.data.reportImages, index);
  },

  // ===== 步骤2：维修时间（picker 手动修改） =====
  onDateChange(e) {
    this.setData({ repairDate: e.detail.value });
  },

  onTimeChange(e) {
    this.setData({ repairTime: e.detail.value });
  },

  // ===== 步骤3：GPS定位 =====
  getLocation() {
    this.setData({ locating: true });
    wx.getLocation({
      type: 'gcj02',
      success: (res) => {
        this.setData({
          locating: false,
          gpsLatitude: res.latitude,
          gpsLongitude: res.longitude,
          gpsText: '纬度 ' + res.latitude.toFixed(5) + '°，经度 ' + res.longitude.toFixed(5) + '°',
          locationAddress: this.data.locationAddress || ''
        });
      },
      fail: (err) => {
        this.setData({ locating: false });
        const msg = (err && err.errMsg) || '';
        // 用户拒绝/未授权定位：引导去设置页开启，否则无法完成 OK 上线
        if (msg.includes('auth deny') || msg.includes('auth denied') || msg.includes('authorize')) {
          wx.showModal({
            title: '需要定位权限',
            content: '维修地点GPS坐标是完成工单的必填项，请在设置中开启定位权限。',
            confirmText: '去设置',
            success: (res) => {
              if (res.confirm) {
                wx.openSetting({
                  success: (settingRes) => {
                    if (settingRes.authSetting['scope.userLocation']) {
                      this.getLocation();
                    }
                  }
                });
              }
            }
          });
          return;
        }
        wx.showToast({ title: '定位失败，请点击「GPS定位」重试', icon: 'none' });
      }
    });
  },

  onAddressInput(e) {
    this.setData({ locationAddress: e.detail.value });
  },

  // ===== 步骤4/5：输入 =====
  onReasonInput(e) {
    this.setData({ faultReason: e.detail.value });
  },

  onActionInput(e) {
    this.setData({ repairAction: e.detail.value });
  },

  // ===== OK上线 =====
  onSubmit() {
    // 提交进行中禁止重复触发（只拦截，不复位——防止在途请求被二次触发）
    if (this.data.submitting) return;
    const { beforeImages, afterImages, faultReason, repairAction, gpsLatitude, gpsLongitude } = this.data;
    if (!beforeImages.length) {
      wx.showToast({ title: '请先拍摄维修前照片（至少1张）', icon: 'none' });
      return;
    }
    if (!afterImages.length) {
      wx.showToast({ title: '请拍摄维修后照片（至少1张）', icon: 'none' });
      return;
    }
    if (!faultReason.trim()) {
      wx.showToast({ title: '请填写故障原因', icon: 'none' });
      return;
    }
    if (!repairAction.trim()) {
      wx.showToast({ title: '请填写维修措施', icon: 'none' });
      return;
    }
    if (!gpsLatitude || !gpsLongitude) {
      wx.showToast({ title: '请先获取维修地点GPS坐标', icon: 'none' });
      return;
    }

    // 延迟弹窗：确保前序 UI 操作完全结束
    setTimeout(() => {
      // 弹窗前再次防重（延迟期间可能已触发提交）
      if (this.data.submitting) return;
      wx.showModal({
        title: '确认OK上线',
        content: '确认设备已修复完成并上线？',
        confirmText: '确认OK上线',
        confirmColor: '#07C160',
        success: (res) => {
          if (res.confirm) this.submit();
        },
        fail: () => {
          // 弹窗失败（如快速双击导致弹窗冲突）不自动提交，让用户重新点击确认
          wx.showToast({ title: '请再次点击「确认OK上线」', icon: 'none' });
        }
      });
    }, 200);
  },

  // 提交维修记录
  async submit() {
    // 双重防重：入口处拦截并发提交
    if (this.data.submitting) return;
    if (!this.data.id) {
      wx.showToast({ title: '工单ID缺失，请重新进入', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    wx.showLoading({ title: '正在提交...', mask: true });
    try {
      // 1. 上传维修前/后照片（照片通过 addImage 写入 order_images 集合，带进度提示）
      const total = this.data.beforeImages.length + this.data.afterImages.length;
      let uploaded = 0;
      const tick = () => {
        uploaded += 1;
        this.setData({ uploadProgress: '正在上传照片 ' + uploaded + '/' + total });
      };
      await this.uploadImages(this.data.beforeImages, 'repair_before', tick);
      await this.uploadImages(this.data.afterImages, 'repair_after', tick);
      // 2. 提交维修记录
      await api.put('/orders/' + this.data.id + '/repair', {
        start_time: this.data.repairDate + ' ' + this.data.repairTime,
        gps_latitude: this.data.gpsLatitude,
        gps_longitude: this.data.gpsLongitude,
        location_address: this.data.locationAddress.trim() || this.data.gpsText,
        fault_reason: this.data.faultReason.trim(),
        repair_action: this.data.repairAction.trim()
      }, { loading: false, silent: true });
      wx.hideLoading();
      wx.showToast({ title: 'OK上线成功', icon: 'success' });
      setTimeout(() => {
        // 跳转回任务列表
        const pages = getCurrentPages();
        if (pages.length > 1) {
          wx.navigateBack();
        } else {
          wx.redirectTo({ url: '/pages/repair/mytasks/mytasks' });
        }
      }, 1200);
    } catch (err) {
      wx.hideLoading();
      this.setData({ submitting: false, uploadProgress: '' });
      wx.showToast({ title: (err && (err.message || err.errMsg)) || '提交失败，请重试', icon: 'none' });
    }
  },

  // 上传一组照片（保留原始错误信息，方便排查；onProgress 每完成一张回调一次）
  uploadImages(paths, imageType, onProgress) {
    if (!paths || !paths.length) return Promise.resolve([]);
    const tasks = paths.map((p) =>
      api.upload(p, { order_id: this.data.id, image_type: imageType }, { silent: true, loading: false })
        .then((res) => {
          if (typeof onProgress === 'function') onProgress();
          return res;
        })
        .catch((err) => {
          const rawMsg = (err && (err.message || err.errMsg)) || '上传失败';
          throw new Error('照片上传失败：' + rawMsg);
        })
    );
    return Promise.all(tasks);
  }
});
