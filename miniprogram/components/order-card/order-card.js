// 工单卡片组件：展示工单摘要信息（工单号、点位、故障描述、状态、时间），点击触发详情跳转
const util = require('../../utils/util.js');

Component({
  properties: {
    // 工单对象：{ id, order_no, location_name, fault_description, status, created_at }
    order: {
      type: Object,
      value: {}
    },
    // 紧凑状态标签：用于维修人员首页/工单池，显示单字框标识
    compactStatus: {
      type: Boolean,
      value: false
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
      const compact = !!this.properties.compactStatus;
      let statusText = util.getStatusText(order.status);
      let statusTextClass = order.status || '';
      if (compact) {
        if (order.status === 'pending_repair') {
          statusText = '维';
          statusTextClass = 'pending_repair compact';
        } else if (order.status === 'repair_returned') {
          statusText = '返';
          statusTextClass = 'repair_returned compact';
        }
      }
      this.setData({
        statusText,
        statusTextClass,
        timeText: util.formatTime(order.created_at || order.createdAt)
      });
    }
  },

  methods: {
    // 点击卡片，向上抛出 select 事件（携带工单 id）。
    // 事件名不用原生 tap：避免 triggerEvent('tap') 与原生 tap 冒泡同时触发父级 bind:tap，
    // 导致一次点击被处理两次（第二次 e.detail.id 为空，跳转出错误详情页）。
    onTap() {
      this.triggerEvent('select', { id: this.data.order.id });
    }
  }
});
