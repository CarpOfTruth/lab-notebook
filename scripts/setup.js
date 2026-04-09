/**
 * Cross-platform setup script.
 * Creates the Python venv, installs dependencies, and installs frontend packages.
 */
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const isWin = process.platform === 'win32';
const root = path.join(__dirname, '..');
const backendDir = path.join(root, 'backend');
const frontendDir = path.join(root, 'frontend');

// Step 1: Create Python virtual environment
console.log('Creating Python virtual environment...');
const python = isWin ? 'python' : 'python3';
execFileSync(python, ['-m', 'venv', '.venv'], { cwd: backendDir, stdio: 'inherit' });

// Step 2: Install Python dependencies
console.log('Installing Python dependencies...');
const pip = path.join(backendDir, '.venv', isWin ? 'Scripts/pip.exe' : 'bin/pip');
execFileSync(pip, ['install', '-r', 'requirements.txt', '-q'], { cwd: backendDir, stdio: 'inherit' });

// Step 3: Copy config.example.json → config.json if not present
const configSrc = path.join(backendDir, 'config.example.json');
const configDst = path.join(backendDir, 'config.json');
if (fs.existsSync(configSrc) && !fs.existsSync(configDst)) {
  fs.copyFileSync(configSrc, configDst);
  console.log('Created config.json from config.example.json');
}

// Step 4: Install frontend npm packages
console.log('Installing frontend dependencies...');
execFileSync('npm', ['install'], { cwd: frontendDir, stdio: 'inherit', shell: isWin });

console.log('\n✓ Setup complete. Run `npm start` to launch the app.');
