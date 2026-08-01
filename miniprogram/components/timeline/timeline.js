// 时间线组件：展示工单状态流转记录
// steps 每项：{ title, time, status: done|current|todo|reject, active, desc }
// active === true 的节点高亮（兼容分工文档 steps=[{title, time, active}] 约定）
Component({
  properties: {
    steps: {
      type: Array,
      value: []
    }
  }
});
