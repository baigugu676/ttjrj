process.env.JWT_SECRET = 'test-only-secret';
process.env.UPLOAD_DIR = 'test-uploads';

const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../src/app');
const { startApp, tokenFor, request } = require('./helpers');

let server;
test.before(async () => { server = await startApp(app); });
test.after(async () => { await server.close(); });

test('健康检查返回统一成功结构', async () => {
  const { response, body } = await request(server.url, '/api/health');
  assert.equal(response.status, 200);
  assert.equal(body.code, 0);
  assert.equal(body.data.status, 'ok');
  assert.match(body.data.time, /^\d{4}-\d{2}-\d{2}T/);
});

test('不存在的接口返回 404 JSON', async () => {
  const { response, body } = await request(server.url, '/api/not-found');
  assert.equal(response.status, 404);
  assert.deepEqual(body, { code: 1, message: '接口不存在' });
});

test('受保护接口缺少 token 返回 401', async () => {
  const { response, body } = await request(server.url, '/api/auth/me');
  assert.equal(response.status, 401);
  assert.equal(body.code, 1);
  assert.equal(body.message, '未登录或 token 缺失');
});

test('非法 token 返回 401', async () => {
  const { response, body } = await request(server.url, '/api/auth/me', {
    headers: { authorization: 'Bearer invalid-token' }
  });
  assert.equal(response.status, 401);
  assert.equal(body.message, 'token 无效或已过期，请重新登录');
});

test('登录参数校验不触发数据库查询', async () => {
  const { response, body } = await request(server.url, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: '', password: '' })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(body, { code: 1, message: '用户名和密码不能为空' });
});

test('工单创建请求先执行认证与参数校验', async () => {
  const token = tokenFor({ id: 10, role: 'user' });
  const { response, body } = await request(server.url, '/api/orders', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify({ location_id: 0, fault_description: '坏' })
  });
  assert.equal(response.status, 200);
  assert.equal(body.code, 1);
  assert.equal(body.message, '请选择故障点位');
});

test('普通用户访问管理员接口返回 403', async () => {
  const token = tokenFor({ id: 11, role: 'user' });
  const { response, body } = await request(server.url, '/api/users', {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(response.status, 403);
  assert.deepEqual(body, { code: 1, message: '无权限执行该操作' });
});
