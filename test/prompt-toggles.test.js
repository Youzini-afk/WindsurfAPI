import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());

function read(rel) {
  return readFileSync(join(ROOT, rel), 'utf8');
}

const PROMPT_FLAGS = [
  'noToolGuardPrompt',
  'communicationSectionPrompt',
  'toolReinforcementPrompt',
  'jsonResponseHint',
  'identityNeutralization',
];

test('built-in prompt behavior flags default on and are exposed in both dashboards', () => {
  const runtime = read('src/runtime-config.js');
  const modern = read('src/dashboard/index.html');
  const sketch = read('src/dashboard/index-sketch.html');

  for (const flag of PROMPT_FLAGS) {
    assert.match(runtime, new RegExp(`${flag}: true`), `${flag} should default on`);
    assert.match(modern, new RegExp(`toggleExperimental\\('${flag}'`), `${flag} missing from modern dashboard`);
    assert.match(sketch, new RegExp(`toggleExperimental\\('${flag}'`), `${flag} missing from sketch dashboard`);
  }
});

test('Cascade proto prompt injections are gated by runtime flags', () => {
  const src = read('src/windsurf.js');

  assert.match(src, /isExperimentalEnabled\('toolReinforcementPrompt'\)[\s\S]{0,160}\+ sp\.toolReinforcement/);
  assert.match(src, /isExperimentalEnabled\('communicationSectionPrompt'\)[\s\S]{0,600}sp\.communicationWithTools/);
  assert.match(src, /isExperimentalEnabled\('communicationSectionPrompt'\)[\s\S]{0,600}spNoTools\.communicationNoTools/);
  assert.match(src, /isExperimentalEnabled\('noToolGuardPrompt'\)[\s\S]{0,350}No tools are available\./);
  assert.match(src, /isExperimentalEnabled\('noToolGuardPrompt'\)[\s\S]{0,900}CRITICAL OPERATING CONSTRAINT/);
});

test('JSON hint injection and Cascade identity cleanup are gated', () => {
  const src = read('src/handlers/chat.js');

  assert.match(src, /wantJson && isExperimentalEnabled\('jsonResponseHint'\)/);
  assert.match(src, /function maybeNeutralizeCascadeIdentity/);
  assert.match(src, /isExperimentalEnabled\('identityNeutralization'\)[\s\S]{0,120}neutralizeCascadeIdentity/);
  assert.match(src, /allText = maybeNeutralizeCascadeIdentity\(allText, model\)/);
  assert.match(src, /cachedText = maybeNeutralizeCascadeIdentity\(cached\.text \|\| '', model\)/);
  assert.match(src, /clean = maybeNeutralizeCascadeIdentity\(clean, model\)/);
});
