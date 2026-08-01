// 工单卡片组件：展示工单摘要信息（工单号、点位、故障描述、状态、时间），点击触发详情跳转
const util = require('../../utils/util.js');

Component({
  properties: {
    // 工单对象：{ id, order_no, location_name, fault_description, status, created_at }
    order: {
      type: Object,
      value: {}
    }
  },

  data: {
    statusText: '',       // 状态中文文案
    statusTextClass: '',  // 状态标签样式类（status-tag.pending_review 等）
    timeText: ''          // 格式化后的提交时间
  },

  observers: {
    'order': function (order) {
      if (!order || !order.id) return;
      this.setData({
        statusText: util.getStatusText(order.status),
        statusTextClass: order.status || '',
        timeText: util.formatTime(order.created_at || order.createdAt)
      });
    }
  },

  methods: {
    // 点击卡片，向上抛出 tap 事件（携带工单 id）
    onTap() {
      this.triggerEvent('tap', { id: this.data.order.id });
    }
  }
});
