// Starts the app in development mode: `npm start`.
// Some editors and tools set ELECTRON_RUN_AS_NODE for child processes, which makes
// Electron behave like plain Node.js — so launch it with that variable removed.
const { spawn } = require('node:child_process');
const electron = require('electron'); // resolves to the Electron executable path

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
