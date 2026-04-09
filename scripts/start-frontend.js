/**
 * Cross-platform frontend starter.
 * Runs Vite via Node directly — avoids shell wrapper and .bin symlink differences.
 */
const { spawn } = require('child_process');
const path = require('path');

const frontendDir = path.join(__dirname, '..', 'frontend');
const vite = path.join(frontendDir, 'node_modules', 'vite', 'bin', 'vite.js');

const proc = spawn(process.execPath, [vite], {
  cwd: frontendDir,
  stdio: 'inherit',
  shell: false,
});

proc.on('exit', (code) => process.exit(code ?? 0));
proc.on('error', (err) => {
  console.error('Failed to start frontend:', err.message);
  console.error('Make sure you have run `npm run setup` first.');
  process.exit(1);
});
