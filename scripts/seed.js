/**
 * Cross-platform demo data seeder.
 */
const { spawn } = require('child_process');
const path = require('path');

const isWin = process.platform === 'win32';
const backendDir = path.join(__dirname, '..', 'backend');
const python = path.join(backendDir, '.venv', isWin ? 'Scripts/python.exe' : 'bin/python');

const proc = spawn(python, ['seed_demo.py'], {
  cwd: backendDir,
  stdio: 'inherit',
  shell: false,
});

proc.on('exit', (code) => process.exit(code ?? 0));
proc.on('error', (err) => {
  console.error('Failed to run seed:', err.message);
  process.exit(1);
});
