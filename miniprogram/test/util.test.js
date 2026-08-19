const test = require('node:test');
const assert = require('node:assert/strict');
const util = require('../utils/util');

test('formatTime 支持 Date、时间戳、ISO 和无效输入', () => {
  assert.equal(util.formatTime(new Date(2026, 0, 2, 3, 4, 5), 'YYYY-MM-DD HH:mm:ss'), '2026-01-02 03:04:05');
  assert.equal(util.formatTime('2026-08-06T10:30:00.000Z', 'YYYY-MM-DD'), '2026-08-06');
  assert.equal(util.formatTime({ $date: '2026-08-06T10:30:00.000Z' }, 'YYYY-MM-DD'), '2026-08-06');
  assert.equal(util.formatTime('not-a-date'), '');
  assert.equal(util.formatTime(null), '');
});

test('splitImages 按类型拆分字符串和对象图片', () => {
  assert.deepEqual(util.splitImages({ images: [
    'cloud://report',
    { image_url: 'cloud://before', image_type: 'repair_before' },
    { url: 'https://after', image_type: 'repair_after' },
    { image_url: '' }
  ] }), {
    report: ['cloud://report'], before: ['cloud://before'], after: ['https://after']
  });
});

test('buildTimelineSteps 反映已完成和驳回状态', () => {
  const completed = util.buildTimelineSteps({
    status: 'completed', order_no: 'WO20260811001', created_at: '2026-08-11T01:00:00Z',
    reviewed_at: '2026-08-11T02:00:00Z',
    repair_records: [{ created_at: '2026-08-11T03:00:00Z', end_time: '2026-08-11T04:00:00Z', repair_action: '更换模块' }],
    acceptance_records: [{ accepted_at: '2026-08-11T05:00:00Z' }]
  });
  assert.equal(completed.length, 5);
  assert.equal(completed[4].status, 'done');

  const rejected = util.buildTimelineSteps({ status: 'rejected', reviewed_at: '2026-08-11T02:00:00Z', reject_reason: '信息不完整' });
  assert.equal(rejected.length, 2);
  assert.equal(rejected[1].status, 'reject');
  assert.equal(rejected[1].desc, '信息不完整');
});

test('buildTimelineSteps 免审核工单显示「免审核」步骤', () => {
  const steps = util.buildTimelineSteps({
    status: 'pending_repair', order_no: 'WO20260819001', created_at: '2026-08-19T01:00:00Z',
    skip_review: true, review_comment: '免审核直接派单'
  });
  assert.equal(steps[1].title, '免审核');
  assert.equal(steps[1].status, 'done');
  assert.equal(steps[1].desc, '免审核直接派单');
  assert.equal(steps[2].title, '维修接单');
});

test('监控状态与百分比辅助函数返回稳定文案', () => {
  assert.equal(util.getMonitorStatusText('normal'), '正常');
  assert.equal(util.getMonitorStatusColor('fault'), '#ef4444');
  assert.equal(util.getMonitorActionText('repair_done'), '提交维修记录');
  assert.equal(util.formatPercent(75), '75%');
  assert.equal(util.formatPercent(12.5), '12.5%');
});
