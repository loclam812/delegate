// The hook table, the tier table and the manifests are written in three places each; these tests
// fail when one of them moves without the others.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const hooks = JSON.parse(read('hooks/hooks.json')).hooks;

const registrations = Object.entries(hooks).flatMap(([event, entries]) =>
  entries.flatMap((entry) => entry.hooks.map((h) => ({ event, script: /hooks\/([\w-]+\.js)/.exec(h.command)[1] }))));

test('every hook in hooks.json exists, and every hook script is registered', () => {
  for (const { script } of registrations) assert.ok(fs.existsSync(path.join(ROOT, 'hooks', script)), script);
  const entryPoints = fs.readdirSync(path.join(ROOT, 'hooks'))
    .filter((f) => f.endsWith('.js') && f !== 'delegate-lib.js' && /runHook\(/.test(read(`hooks/${f}`)));
  for (const script of entryPoints) assert.ok(registrations.some((r) => r.script === script), `${script} is not in hooks.json`);
});

test('the README hook table lists every registered hook under each of its events', () => {
  const readme = read('README.md');
  for (const { event, script } of registrations) {
    const row = readme.split('\n').find((line) => line.startsWith(`| \`${script}\` |`));
    assert.ok(row, `${script} has no README row`);
    assert.match(row.split(/(?<!\\)\|/)[2], new RegExp(event), `${script} row does not name ${event}`);
  }
});

test('plugin.json and marketplace.json carry the same version', () => {
  const plugin = JSON.parse(read('.claude-plugin/plugin.json'));
  const market = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.strictEqual(market.plugins.find((p) => p.name === plugin.name).version, plugin.version);
});

test('the tier table in SKILL.md and the one the guard injects agree', () => {
  const skill = read('skills/delegate/SKILL.md');
  const guard = read('hooks/delegate-guard.js');
  for (const [row, line, model, effort] of [
    ['Locator', 'locator', 'haiku', 'low'],
    ['Research', 'research', 'sonnet', 'medium'],
    ['Implementer', 'implementer', 'sonnet', 'medium'],
  ]) {
    assert.match(skill, new RegExp(`^\\| ${row}[^|]*\\| ${model} \\| ${effort} \\|`, 'm'), `SKILL.md ${row}`);
    assert.match(guard, new RegExp(`- ${line}[^\\n]*: ${model}, ${effort}`), `guard ${line}`);
  }
});
