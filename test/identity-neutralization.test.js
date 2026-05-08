import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { neutralizeCascadeIdentity } from '../src/handlers/chat.js';

// Cascade's planner system prompt teaches the upstream model to refer to
// itself as "Cascade", to claim it was "made by Codeium" or "by Windsurf",
// and to talk about "Cascade's workspace". Claude Code (and any caller
// expecting Anthropic-equivalent output) must not see those leaks.
//
// neutralizeCascadeIdentity rewrites the most common Cascade-isms back to
// the requested model identity, then removes any leftover standalone
// Windsurf/Cascade brand tokens case-insensitively. The final scrub uses
// word boundaries so longer identifiers like WindsurfAPI are not truncated.

describe('neutralizeCascadeIdentity', () => {
  const model = 'claude-opus-4-7';

  it('rewrites first-person identity claims', () => {
    assert.equal(
      neutralizeCascadeIdentity('I am Cascade and I will help.', model),
      `I am ${model} and I will help.`
    );
    assert.equal(
      neutralizeCascadeIdentity("I'm Cascade, ready to help.", model),
      `I'm ${model}, ready to help.`
    );
    assert.equal(
      neutralizeCascadeIdentity('Hi! my name is Cascade.', model),
      `Hi! my name is ${model}.`
    );
  });

  it('rewrites third-person self-reference', () => {
    assert.equal(
      neutralizeCascadeIdentity('Cascade is an AI coding assistant built by Windsurf.', model),
      `${model} is an AI assistant built by Anthropic.`
    );
    assert.equal(
      neutralizeCascadeIdentity('As Cascade, I will check that.', model),
      `As ${model}, I will check that.`
    );
    assert.equal(
      neutralizeCascadeIdentity('Acting as Cascade, I will check that.', model),
      `As ${model}, I will check that.`
    );
  });

  it('rewrites provider attribution variants', () => {
    assert.equal(
      neutralizeCascadeIdentity('I was developed by Codeium.', model),
      'I was developed by Anthropic.'
    );
    assert.equal(
      neutralizeCascadeIdentity('I was created by Windsurf.', model),
      'I was created by Anthropic.'
    );
    assert.equal(
      neutralizeCascadeIdentity('I was built by Windsurf.', model),
      'I was built by Anthropic.'
    );
    assert.equal(
      neutralizeCascadeIdentity("Codeium's Cascade can help with that.", model),
      `${model} can help with that.`
    );
    assert.equal(
      neutralizeCascadeIdentity('Windsurf Cascade is here.', model),
      `${model} is here.`
    );
  });

  it('rewrites Chinese Cascade identity leaks', () => {
    assert.equal(
      neutralizeCascadeIdentity('我是 Cascade，一个由 Windsurf 提供的 AI 编程助手。', model),
      `我是 ${model}，一个由 Anthropic 提供的 AI 助手。`
    );
    assert.equal(
      neutralizeCascadeIdentity('Cascade 是一个由 Codeium 提供的 AI 编程助手。', model),
      `${model} 是一个由 Anthropic 提供的 AI 助手。`
    );
    assert.equal(
      neutralizeCascadeIdentity('作为 Cascade，我可以帮你。', model),
      `作为 ${model}，我可以帮你。`
    );
  });

  it('rewrites Cascade workspace narration', () => {
    assert.equal(
      neutralizeCascadeIdentity("Let me check Cascade's workspace.", model),
      'Let me check the workspace.'
    );
    assert.equal(
      neutralizeCascadeIdentity('I will use the Cascade workspace.', model),
      'I will use the workspace.'
    );
  });

  it('scrubs leftover Windsurf/Cascade tokens case-insensitively', () => {
    assert.equal(
      neutralizeCascadeIdentity('Leftover CASCADE and windsurf tokens.', model),
      'Leftover and tokens.'
    );
    assert.equal(
      neutralizeCascadeIdentity('Cascade, Windsurf, and windSurf are gone.', model),
      ',, and are gone.'
    );
  });

  it('does not truncate longer identifiers containing the brand tokens', () => {
    const text = 'WindsurfAPI and useCascadeFlag should stay intact.';
    assert.equal(neutralizeCascadeIdentity(text, model), text);
  });

  it('still applies brand scrub when modelName has no known provider mapping', () => {
    assert.equal(neutralizeCascadeIdentity('I am Cascade.', 'mystery-model'), 'I am.');
    assert.equal(neutralizeCascadeIdentity('WindsurfAPI stays.', 'mystery-model'), 'WindsurfAPI stays.');
  });

  it('returns falsy inputs unchanged', () => {
    assert.equal(neutralizeCascadeIdentity('', model), '');
    assert.equal(neutralizeCascadeIdentity(null, model), null);
    assert.equal(neutralizeCascadeIdentity('I am Cascade.', null), 'I am Cascade.');
  });
});
