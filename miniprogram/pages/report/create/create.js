// 新建报修页：点位选择 + 故障描述 + 照片上传（最多9张）+ 维修要求
// 提交逻辑（与后端接口对齐）：
//   1. 先 POST /api/orders 创建工单，拿到工单 id
//   2. 再逐张上传照片（image_type=report，携带 order_id），由后端写入 order_images 表
//   3. 全部完成 → 跳转列表页
const api = require('../../../utils/api.js');
const util = require('../../../utils/util.js');

Page({
  data: {
    locations: [],        // 点位列表（来自 /api/locations）
    filteredLocations: [], // 当前搜索结果
    locationKeyword: '',  // 点位搜索关键词
    locationNames: [],    // 点位名称（picker 展示用）
    locationIndex: -1,    // 当前选中点位下标
    locationId: '',       // 选中点位 id
    description: '',      // 故障描述
    requirements: '',     // 维修要求（选填）
    images: [],           // 已选图片 [{ tempPath }]
    submitting: false     // 是否正在提交
  },

  onLoad() {
    const app = getApp();
    if (!app.checkLogin()) return;
    this.loadLocations();
  },

  // 获取点位列表
  loadLocations() {
    api.get('/locations', {}, { loading: false }).then((list) => {
      const locations = Array.isArray(list) ? list : [];
      this.setData({
        locations,
        filteredLocations: locations,
        locationNames: locations.map((l) => this.getLocationLabel(l))
      });
    }).catch((err) => { console.error('[create] 加载点位列表失败:', err); });
  },

  onLocationChange(e) {
    const index = Number(e.detail.value);
    const location = this.data.filteredLocations[index];
    this.setData({
      locationIndex: index,
      locationId: location ? location.id : ''
    });
  },

  getLocationLabel(location) {
    const name = (location && location.name) || '';
    const area = (location && location.area) || '';
    const type = (location && location.device_type) || '';
    return [name, area, type].filter(Boolean).join(' - ');
  },

  onLocationSearch(e) {
    const locationKeyword = (e.detail.value || '').trim();
    const keyword = locationKeyword.toLowerCase();
    const filteredLocations = this.data.locations.filter((location) => {
      const text = [location.name, location.area, location.device_type]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return !keyword || text.includes(keyword);
    });
    this.setData({
      locationKeyword,
      filteredLocations,
      locationNames: filteredLocations.map((location) => this.getLocationLabel(location)),
      locationIndex: -1,
      locationId: ''
    });
  },

  onDescInput(e) {
    this.setData({ description: e.detail.value });
  },

  onReqInput(e) {
    this.setData({ requirements: e.detail.value });
  },

  // 选择图片（拍照 + 相册），仅暂存本地路径，提交时统一上传
  onChooseImage() {
    const remain = 9 - this.data.images.length;
    if (remain <= 0) {
      wx.showToast({ title: '最多上传9张图片', icon: 'none' });
      return;
    }
    wx.chooseImage({
      count: remain,
      sizeType: ['compressed'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const newItems = res.tempFilePaths.map((p) => ({ tempPath: p }));
        this.setData({ images: this.data.images.concat(newItems) });
      }
    });
  },

  // 删除图片
  onDeleteImage(e) {
    const { index } = e.currentTarget.dataset;
    const images = this.data.images.slice();
    images.splice(index, 1);
    this.setData({ images });
  },

  // 预览图片
  onPreview(e) {
    const { index } = e.currentTarget.dataset;
    util.previewImages(this.data.images.map((it) => it.tempPath), index);
  },

  // 提交报修：先建工单，再传照片
  onSubmit() {
    const { locationId, locationIndex, description, requirements, images, submitting } = this.data;
    if (submitting) return;
    if (locationIndex < 0) {
      wx.showToast({ title: '请选择故障点位', icon: 'none' });
      return;
    }
    if (!description.trim()) {
      wx.showToast({ title: '请填写故障描述', icon: 'none' });
      return;
    }

    this.setData({ submitting: true });
    wx.showLoading({ title: '正在提交...', mask: true });

    api.post('/orders', {
      location_id: locationId,
      fault_description: description.trim(),
      repair_requirements: requirements.trim() || null
    }, { loading: false, silent: true }).then((res) => {
      const orderId = res && (res.id || res.order_id);
      if (!orderId) {
        throw new Error('创建工单失败');
      }
      // 先上传照片（成功后自动写入 order_images）
      return this.uploadImages(orderId, images).then(() => orderId);
    }).then(() => {
      wx.hideLoading();
      wx.showToast({ title: '报修提交成功', icon: 'success' });
      setTimeout(() => {
        wx.setStorageSync('listStatus', 'pending_review');
        wx.switchTab({ url: '/pages/report/list/list' });
      }, 1200);
    }).catch((err) => {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: (err && err.message) || '提交失败，请重试', icon: 'none' });
    });
  },

  // 上传全部照片（携带 order_id 与 image_type=report）
  uploadImages(orderId, images) {
    if (!images || !images.length) return Promise.resolve();
    const tasks = images.map((item) =>
      api.upload(item.tempPath, { order_id: orderId, image_type: 'report' }, { silent: true, loading: false })
        .catch((err) => {
          console.error('[create] 照片上传失败:', err);
          return null;
        })
    );
    return Promise.all(tasks);
  }
});
