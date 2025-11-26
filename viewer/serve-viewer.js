import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 8080;

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
};

const server = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/l1-stats-viewer.html' : req.url;
  
  if (filePath.startsWith('/cache/')) {
    filePath = path.join(__dirname, '..', filePath);
  } else {
    filePath = path.join(__dirname, filePath);
  }

  const extname = path.extname(filePath).toLowerCase();
  let contentType = mimeTypes[extname] || 'application/octet-stream';
  
  if (extname === '.json') {
    contentType = 'application/json';
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<h1>404 - File Not Found</h1>', 'utf-8');
      } else {
        res.writeHead(500);
        res.end(`Server Error: ${err.code}`, 'utf-8');
      }
    } else {
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content, 'utf-8');
    }
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/`);
  console.log(`Open http://localhost:${PORT}/ in your browser`);
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Try a different port:`);
    console.error(`  PORT=8081 npm run serve-viewer`);
    process.exit(1);
  } else {
    throw err;
  }
});

