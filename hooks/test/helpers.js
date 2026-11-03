const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function mkTmpConfig() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'delegate-test-'));
}

function runNode(file, stdinText, env = {}) {
  const r = spawnSync(process.execPath, [file], {
    input: stdinText,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

module.exports = { mkTmpConfig, runNode };
