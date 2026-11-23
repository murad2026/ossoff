// Run: cd worker && node --test test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../src/moderation.js';
import { signals, normalize, refCode } from '../src/util.js';

test('parse: valid publish JSON', () => {
  const r = parse('{"verdict":"publish","category":"ok","reason":"","tags":["Personal story","Bogus tag"],"headline":"A nurse\'s reason","polished":"I want him to run."}');
  assert.equal(r.verdict, 'publish');
  assert.deepEqual(r.tags, ['Personal story']);
  assert.equal(r.polished, 'I want him to run.');
});

test('parse: reject clears polished text', () => {
  const r = parse('Sure! {"verdict":"reject","category":"harassment","reason":"No insults.","tags":[],"headline":"x","polished":"something"}');
  assert.equal(r.verdict, 'reject');
  assert.equal(r.polished, '');
});

test('parse: garbage falls back to human review', () => {
  assert.equal(parse('not json at all').verdict, 'review');
  assert.equal(parse('{"verdict":"maybe"}').verdict, 'review');
});

test('signals catch spam patterns', () => {
  assert.ok(signals('visit http://a.com and http://b.com now').includes('link_spam'));
  assert.ok(signals('THIS IS ALL CAPS SHOUTING ABOUT EVERYTHING EVER').includes('shouting'));
  assert.ok(signals('nooooooooo way').includes('repeated_chars'));
  assert.deepEqual(signals('I am a teacher in Savannah and I want Jon to run because he fights corruption.'), []);
});

test('parse: accepts an object from tool_use', () => {
  const r = parse({ verdict: 'publish', category: 'ok', reason: '', tags: ['Personal story'], headline: 'Hi there', polished: 'x' });
  assert.equal(r.verdict, 'publish');
  assert.deepEqual(r.tags, ['Personal story']);
});

test('normalize and ref codes', () => {
  assert.equal(normalize('  Run, JON — run!! '), 'run jon run');
  const c = refCode();
  assert.match(c, /^[A-Z2-9]{6}$/);
});
