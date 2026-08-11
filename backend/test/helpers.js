const http = require('node:http');
const jwt = require('jsonwebtoken');

async function startApp(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()))
  };
}

function tokenFor(user = {}) {
  return jwt.sign({
    id: user.id || 1,
    role: user.role || 'user',
    real_name: user.real_name || '测试用户'
  }, process.env.JWT_SECRET);
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json();
  return { response, body };
}

module.exports = { startApp, tokenFor, request };
