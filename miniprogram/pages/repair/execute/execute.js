// 维修执行页（核心页面）：维修前拍照 → 维修时间 → GPS定位 → 故障原因 → 维修措施 → 维修后拍照 → OK上线
// 提交逻辑：
//   1. 上传维修前/后照片（order_id + image_type: repair_before / repair_after）
//   2. 调用 PUT /api/orders/:id/repair 提交维修记录
//   3. 成功后跳转回任务列表
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

const DRAFT_PREFIX = 'repair_execute_draft_';

function draftKey(id) {
  let uid = '';
  try {
    const app = getApp();
    uid = (app && app.globalData && app.globalData.userInfo && app.globalData.userInfo.id) || '';
  } catch (e) {
    // 忽略获取用户信息异常
  }
  return DRAFT_PREFIX + uid + '_' + id;
}

function readDraft(id) {
  try {
    return wx.getStorageSync(draftKey(id)) || null;
  } catch (e) {
    return null;
  }
}

function clearDraft(id) {
  try {
    wx.removeStorageSync(draftKey(id));
  } catch (e) {
    // 忽略缓存清理异常
  }
}

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
    suspending: false,    // 是否挂起中
    loadError: false,     // 工单加载失败
    uploadProgress: '',   // 照片上传进度提示
    showConfirm: false,   // 自绘确认弹窗是否显示
    restoredDraft: false  // 是否已恢复上次挂起保存的维修内容
  },

  onLoad(options) {
    const app = getApp();
    if (!app.checkLogin()) return;
    // 角色权限控制：仅维修人员可访问
    if (!util.guardRole('repairer')) return;
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
        reportImages: images.report,
        beforeImages: images.before,
        afterImages: images.after
      });
      this.restoreDraft(order.suspend_draft);
      wx.setNavigationBarTitle({
        title: order.order_no ? ('维修 ' + order.order_no) : '维修执行'
      });
      // 兜底：若工单仍是"待维修"状态（未接单），先自动接单
      // 仅尝试一次：接单失败后重载详情不再重试，避免失败→重载→再失败的循环
      if (order.status === 'pending_repair' && !this._autoAccepted) {
        this._autoAccepted = true;
        const accepted = await this.autoAcceptRepair();
        // 自动接单成功后本地状态同步为维修中，确保挂起按钮可用
        if (accepted && this.data.order && this.data.order.status === 'pending_repair') {
          this.setData({
            'order.status': 'repairing',
            statusText: util.getStatusText('repairing')
          });
        }
      }
      // 进入页面自动尝试定位；已有挂起草稿坐标时保留原坐标，避免覆盖已填内容
      if (!this.data.gpsLatitude || !this.data.gpsLongitude) {
        this.getLocation();
      }
    }).catch((err) => {
      console.error('[execute] 加载工单失败:', err);
      // 失败可重试，不永久停留在加载中
      this.setData({ loadError: true });
    });
  },

  // 恢复挂起草稿：优先使用服务端保存的草稿（交接给其他维修人员也能恢复），其次本地缓存
  restoreDraft(serverDraft) {
    const id = this.data.id;
    if (!id) return;
    let draft = serverDraft || null;
    if (typeof draft === 'string' && draft) {
      try {
        draft = JSON.parse(draft);
      } catch (e) {
        draft = null;
      }
    }
    if (!draft) draft = readDraft(id);
    if (!draft) return;
    this.setData({
      beforeImages: draft.beforeImages || [],
      afterImages: draft.afterImages || [],
      repairDate: draft.repairDate || this.data.repairDate,
      repairTime: draft.repairTime || this.data.repairTime,
      gpsText: draft.gpsText || (draft.gpsLatitude && draft.gpsLongitude ? '纬度 ' + Number(draft.gpsLatitude).toFixed(5) + '°，经度 ' + Number(draft.gpsLongitude).toFixed(5) + '°' : ''),
      gpsLatitude: draft.gpsLatitude || "",
      gpsLongitude: draft.gpsLongitude || "",
      locationAddress: draft.locationAddress || "",
      faultReason: draft.faultReason || "",
      repairAction: draft.repairAction || "",
      restoredDraft: true
    });
  },

  // 收集当前维修表单内容（用于本地缓存和提交到服务端）
  collectDraft() {
    return {
      beforeImages: this.data.beforeImages,
      afterImages: this.data.afterImages,
      repairDate: this.data.repairDate,
      repairTime: this.data.repairTime,
      gpsText: this.data.gpsText,
      gpsLatitude: this.data.gpsLatitude,
      gpsLongitude: this.data.gpsLongitude,
      locationAddress: this.data.locationAddress,
      faultReason: this.data.faultReason,
      repairAction: this.data.repairAction
    };
  },

  // 保存本地挂起草稿（同时保留一份在当前设备，方便离线/容错）
  saveDraft() {
    const id = this.data.id;
    if (!id) return;
    try {
      wx.setStorageSync(draftKey(id), Object.assign({ savedAt: Date.now() }, this.collectDraft()));
    } catch (e) {
      console.error("[execute] 保存挂起草稿失败:", e);
    }
  },

  // 上传挂起草稿中的本地照片，返回可跨设备恢复的云文件ID
  async uploadDraftImages() {
    const uploadOne = (p, imageType) => {
      if (p && String(p).indexOf('cloud://') === 0) return Promise.resolve({ fileID: p });
      return api.upload(p, { order_id: this.data.id, image_type: imageType }, { silent: true, loading: false });
    };
    const [beforeRes, afterRes] = await Promise.all([
      Promise.all((this.data.beforeImages || []).map((p) => uploadOne(p, 'repair_before'))),
      Promise.all((this.data.afterImages || []).map((p) => uploadOne(p, 'repair_after')))
    ]);
    return {
      beforeImages: beforeRes.map((r) => (r && (r.fileID || r.url)) || ''),
      afterImages: afterRes.map((r) => (r && (r.fileID || r.url)) || '')
    };
  },

  // 挂起当前维修：先上传照片到云存储，再保存草稿到工单，确保交接维修人员也能恢复
  async onSuspend() {
    if (this.data.submitting || this.data.suspending || this.data.showConfirm) return;
    const { order, id } = this.data;
    if (!order || order.status !== 'repairing') {
      wx.showToast({ title: '当前状态不可挂起', icon: 'none' });
      return;
    }
    this.saveDraft();
    this.setData({ suspending: true });
    wx.showLoading({ title: '正在保存挂起内容...', mask: true });
    try {
      const uploaded = await this.uploadDraftImages();
      // 本地照片已转为云文件ID，后续提交/再次挂起不会重复上传
      this.setData({
        beforeImages: uploaded.beforeImages,
        afterImages: uploaded.afterImages
      });
      this.saveDraft();
      const draft = Object.assign({}, this.collectDraft(), uploaded);
      await api.put('/orders/' + id + '/suspend', { reason: '', draft }, { loading: false, silent: true, timeoutMs: 20000 });
      wx.hideLoading();
      wx.showToast({ title: '已挂起，内容已保留', icon: 'success' });
      setTimeout(() => this.backToList(), 300);
    } catch (err) {
      wx.hideLoading();
      this.setData({ suspending: false });
      wx.showToast({ title: (err && err.message) || '挂起失败，请重试', icon: 'none' });
    }
  },

  // 返回任务列表（优先返回上一页，否则直达维修任务）
  backToList() {
    const pages = getCurrentPages();
    if (pages.length > 1) {
      wx.navigateBack();
    } else {
      wx.redirectTo({ url: '/pages/repair/mytasks/mytasks' });
    }
  },

  // 自动接单（await 确保接单完成后再允许提交；失败则提示并重载工单状态）
  async autoAcceptRepair() {
    try {
      await api.put('/orders/' + this.data.id + '/accept-repair', {}, { silent: true });
      return true;
    } catch (err) {
      // 接单失败：重载工单详情以确认当前实际状态（如已被接单/流转），
      // 避免用户填完表单后提交时才被告知状态不符
      const msg = (err && err.message) || '接单失败';
      wx.showToast({ title: msg + '，已刷新工单状态', icon: 'none', duration: 2500 });
      this.loadOrder();
      return false;
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
    // 提交进行中或确认弹窗已打开时禁止重复触发（只拦截，不复位——防止在途请求被二次触发）
    if (this.data.submitting || this.data.showConfirm) return;
    if (!this.data.order || !['repairing', 'repair_returned'].includes(this.data.order.status)) {
      wx.showToast({ title: '当前工单状态不可提交', icon: 'none' });
      return;
    }
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

    // 自绘确认弹窗：不再使用 wx.showModal。系统弹窗在开发者工具/部分真机上
    // 存在弹窗冲突问题（连续调用或与其它系统弹层并存时直接 fail，
    // 表现为弹窗闪没 + 提示「请再次点击确认OK上线」），提交永远无法开始。
    // 自绘弹窗完全由页面状态控制，不存在平台弹窗冲突。
    if (this.data.showConfirm) return;
    this.setData({ showConfirm: true });
  },

  // 确认弹窗：点「确认OK上线」开始提交
  onConfirmOk() {
    if (!this.data.showConfirm) return;
    this.setData({ showConfirm: false });
    this.submit();
  },

  // 确认弹窗：点「取消」或遮罩关闭
  onConfirmCancel() {
    if (!this.data.showConfirm) return;
    this.setData({ showConfirm: false });
  },

  // 弹窗内容区占位：catchtap 阻止点击冒泡到遮罩（不做任何事）
  noop() {},

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
      // 2. 提交维修记录（云函数冷启动+多次写库+通知扇出可能较慢，超时放宽到 20 秒）
      await api.put('/orders/' + this.data.id + '/repair', {
        start_time: this.data.repairDate + ' ' + this.data.repairTime,
        gps_latitude: this.data.gpsLatitude,
        gps_longitude: this.data.gpsLongitude,
        location_address: this.data.locationAddress.trim() || this.data.gpsText,
        fault_reason: this.data.faultReason.trim(),
        repair_action: this.data.repairAction.trim()
      }, { loading: false, silent: true, timeoutMs: 20000 });
      wx.hideLoading();
      clearDraft(this.data.id);
      wx.showToast({ title: 'OK上线成功', icon: 'success' });
      setTimeout(() => this.backToList(), 300);
    } catch (err) {
      wx.hideLoading();
      this.setData({ submitting: false, uploadProgress: '' });
      wx.showToast({ title: (err && (err.message || err.errMsg)) || '提交失败，请重试', icon: 'none' });
    }
  },

  // 上传一组照片（保留原始错误信息，方便排查；onProgress 每完成一张回调一次）
  // 已上传的 cloud:// 文件直接跳过，避免交接恢复后重复上传
  uploadImages(paths, imageType, onProgress) {
    if (!paths || !paths.length) return Promise.resolve([]);
    const tasks = paths.map((p) => {
      if (p && String(p).indexOf('cloud://') === 0) {
        if (typeof onProgress === 'function') onProgress();
        return Promise.resolve({ fileID: p });
      }
      return api.upload(p, { order_id: this.data.id, image_type: imageType }, { silent: true, loading: false })
        .then((res) => {
          if (typeof onProgress === 'function') onProgress();
          return res;
        })
        .catch((err) => {
          const rawMsg = (err && (err.message || err.errMsg)) || '上传失败';
          throw new Error('照片上传失败：' + rawMsg);
        });
    });
    return Promise.all(tasks);
  }
});
