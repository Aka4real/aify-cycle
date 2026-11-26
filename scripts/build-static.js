/**
 * AifyCycle - Static Frontend Build Script for Vercel
 * Copies only public frontend assets into dist/ so Vercel serves them from the
 * Edge CDN without triggering @vercel/backends on server.js or exposing backend files.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

const STATIC_FILES = [
  'index.html',
  'admin.html',
  'robots.txt',
  'site.webmanifest',
  'favicon.ico',
  'favicon.svg',
  'favicon.png',
  'favicon-16x16.png',
  'favicon-32x32.png',
  'apple-touch-icon.png',
  'icon-192.png',
  'icon-512.png',
  'og-image.png',
  'og-image.jpg'
];

const STATIC_DIRS = ['assets', 'css', 'js'];

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

if (fs.existsSync(DIST)) {
  fs.rmSync(DIST, { recursive: true, force: true });
}
fs.mkdirSync(DIST, { recursive: true });

for (const file of STATIC_FILES) {
  const srcPath = path.join(ROOT, file);
  if (fs.existsSync(srcPath)) {
    fs.copyFileSync(srcPath, path.join(DIST, file));
  }
}

for (const dir of STATIC_DIRS) {
  const srcDir = path.join(ROOT, dir);
  if (fs.existsSync(srcDir)) {
    copyDirSync(srcDir, path.join(DIST, dir));
  }
}

console.log('✓ AifyCycle static assets packaged into dist/');
