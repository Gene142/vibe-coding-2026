// Dev-only static server for previewing the app (the app itself needs no server).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.csv': 'text/csv', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  const file = path.normalize(path.join(root, url === '/' ? 'index.html' : url));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}).listen(4173, () => console.log('serving on http://localhost:4173'));
