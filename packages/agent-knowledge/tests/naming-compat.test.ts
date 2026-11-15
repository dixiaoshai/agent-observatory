import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentKnowledge, KnowRelay } from '../src/application/index.js';
import { AgentKnowledgeError, KnowRelayError } from '../src/core/index.js';

test('legacy class names are aliases of canonical classes', () => {
  assert.equal(AgentKnowledge, KnowRelay);
  assert.equal(AgentKnowledgeError, KnowRelayError);
  assert.ok(new KnowRelayError('TEST', 'test') instanceof AgentKnowledgeError);
});
