// 新建报修页：点位选择 + 故障描述 + 照片上传（最多9张）+ 维修要求
// 提交逻辑：先逐张上传图片（image_type=report）→ POST /api/orders
const api = require('../../utils/api.js');
const util = require('../../utils/util.js');

Page({
  data: {
    locations: [],        // 点位列表（来自 /api/locations）
    locationNames: [],    // 点位名称（picker 展示用）
    locationIndex: -1,    // 当前选中点位下标
    locationId: '',       // 选中点位 id
    description: '',      // 故障描述
    requirements: '',     // 维修要求（选填）
    images: [],           // 已选图片 [{ tempPath, url }]
    uploading: 0,         // 正在上传的图片数量
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
        locationNames: locations.map((l) => l.name)
      });
    }).catch(() => {});
  },

  onLocationChange(e) {
    const index = Number(e.detail.value);
    const location = this.data.locations[index];
    this.setData({
      locationIndex: index,
      locationId: location ? location.id : ''
    });
  },

  onDescInput(e) {
    this.setData({ description: e.detail.value });
  },

  onReqInput(e) {
    this.setData({ requirements: e.detail.value });
  },

  // 选择图片（拍照 + 相册），选中后立即上传
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
        const newItems = res.tempFilePaths.map((p) => ({ tempPath: p, url: '' }));
        const images = this.data.images.concat(newItems);
        const uploading = this.data.uploading + newItems.length;
        this.setData({ images, uploading });
        newItems.forEach((item) => this.uploadOne(item));
      }
    });
  },

  // 逐张上传图片（image_type=report，先传图后建单）
  uploadOne(item) {
    api.upload(item.tempPath, { image_type: 'report' }, { silent: true, loading: false })
      .then((res) => {
        // 后端可能返回字符串URL，或 { url } / { image_url } / { id }
        const url = typeof res === 'string' ? res : (res && (res.url || res.image_url)) || '';
        const images = this.data.images.map((it) =>
          it.tempPath === item.tempPath ? { tempPath: it.tempPath, url: url || it.tempPath, id: (res && res.id) || '' } : it
        );
        this.finishUpload(images);
      })
      .catch(() => {
        // 上传失败：移除该张并提示
        const images = this.data.images.filter((it) => it.tempPath !== item.tempPath);
        this.finishUpload(images);
        wx.showToast({ title: '有图片上传失败，已自动移除', icon: 'none' });
      });
  },

  finishUpload(images) {
    const uploading = Math.max(0, this.data.uploading - 1);
    this.setData({ images, uploading });
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
    const urls = this.data.images.map((it) => it.url || it.tempPath);
    util.previewImages(urls, index);
  },

  // 提交报修
  onSubmit() {
    const { locationId, locationIndex, description, requirements, images, uploading, submitting } = this.data;
    if (submitting) return;
    if (locationIndex < 0) {
      wx.showToast({ title: '请选择故障点位', icon: 'none' });
      return;
    }
    if (!description.trim()) {
      wx.showToast({ title: '请填写故障描述', icon: 'none' });
      return;
    }
    if (uploading > 0) {
      wx.showToast({ title: '图片上传中，请稍候', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    api.post('/orders', {
      location_id: locationId,
      fault_description: description.trim(),
      repair_requirements: requirements.trim(),
      // 图片：优先传后端返回的 id，无 id 时传 url
      images: images.map((it) => it.id || it.url).filter(Boolean)
    }).then(() => {
      wx.showToast({ title: '报修提交成功', icon: 'success' });
      setTimeout(() => {
        wx.switchTab({ url: '/pages/report/list' });
      }, 1200);
    }).catch(() => {
      this.setData({ submitting: false });
    });
  }
});
