/**
 * Cross-platform backend starter.
 * Resolves the correct venv path on Mac/Linux (.venv/bin) and Windows (.venv/Scripts).
 */
const { spawn } = require('child_process');
const path = require('path');

const isWin = process.platform === 'win32';
const backendDir = path.join(__dirname, '..', 'backend');
const uvicorn = path.join(backendDir, '.venv', isWin ? 'Scripts/uvicorn.exe' : 'bin/uvicorn');

const proc = spawn(uvicorn, ['main:app', '--reload', '--port', '8000'], {
  cwd: backendDir,
  stdio: 'inherit',
  shell: false,
});

proc.on('exit', (code) => process.exit(code ?? 0));
proc.on('error', (err) => {
  console.error('Failed to start backend:', err.message);
  console.error('Make sure you have run `npm run setup` first.');
  process.exit(1);
});
