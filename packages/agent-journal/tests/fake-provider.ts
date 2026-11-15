import type { ChatMessage, ChatProvider, ChatResult } from '../src/provider.ts';

const USAGE = { input_tokens: 100, output_tokens: 20, total_tokens: 120 };

export class ScriptedProvider implements ChatProvider {
  calls: Array<{ messages: ChatMessage[]; maxOutputTokens: number }> = [];
  private readonly responses: Array<string | Error>;

  constructor(responses: Array<string | Error>) {
    this.responses = [...responses];
  }

  async complete(messages: ChatMessage[], options: { maxOutputTokens: number; timeoutMs?: number }): Promise<ChatResult> {
    this.calls.push({ messages, maxOutputTokens: options.maxOutputTokens });
    const next = this.responses.shift();
    if (next instanceof Error) throw next;
    if (typeof next !== 'string') throw new Error('ScriptedProvider: no scripted response left');
    return { content: next, usage: { ...USAGE }, model: 'fake-model', finishReason: 'stop' };
  }
}

function userJson(messages: ChatMessage[]): Record<string, unknown> {
  const user = messages.find((message) => message.role === 'user');
  if (!user) throw new Error('fake provider: missing user message');
  return JSON.parse(user.content) as Record<string, unknown>;
}

/** Deterministic fake that answers map/reduce based on the actual prompt. */
export class DynamicProvider implements ChatProvider {
  calls: Array<{ phase: 'map' | 'reduce'; messages: ChatMessage[] }> = [];
  private readonly failMap: boolean;
  private readonly failReduce: boolean;

  constructor(options: { failMap?: boolean; failReduce?: boolean } = {}) {
    this.failMap = options.failMap === true;
    this.failReduce = options.failReduce === true;
  }

  async complete(messages: ChatMessage[], options: { maxOutputTokens: number; timeoutMs?: number }): Promise<ChatResult> {
    const system = messages.find((message) => message.role === 'system')?.content ?? '';
    if (system.includes('summarize coding-agent work sessions')) {
      this.calls.push({ phase: 'map', messages });
      if (this.failMap) return { content: 'not json', usage: { ...USAGE }, model: 'fake-model', finishReason: 'stop' };
      const input = userJson(messages);
      const sessions = Array.isArray(input.sessions) ? input.sessions as Array<Record<string, unknown>> : [];
      return {
        content: JSON.stringify({
          sessions: sessions.map((session, index) => ({
            session_key: session.session_key,
            summary: `fake summary ${index + 1}`,
            decisions: index === 0 ? ['fake decision'] : [],
            follow_ups: session.open_ended === true ? ['fake follow-up'] : [],
          })),
        }),
        usage: { ...USAGE },
        model: 'fake-model',
        finishReason: 'stop',
      };
    }
    if (system.includes('write the daily review')) {
      this.calls.push({ phase: 'reduce', messages });
      if (this.failReduce) return { content: 'garbage', usage: { ...USAGE }, model: 'fake-model', finishReason: 'stop' };
      const input = userJson(messages);
      const digests = Array.isArray(input.session_digests) ? input.session_digests as Array<Record<string, unknown>> : [];
      const projectStats = Array.isArray(input.project_stats) ? input.project_stats as Array<Record<string, unknown>> : [];
      return {
        content: JSON.stringify({
          highlights: ['fake highlight'],
          projects: projectStats.map((project) => ({ project_id: project.project_id, summary: 'fake project summary' })),
          decisions: ['fake decision'],
          blockers: [],
          next_steps: ['fake next step'],
          session_notes: digests.map((digest) => ({
            session_key: digest.session_key,
            summary: `fake session note for ${String(digest.session_key)}`,
            decisions: [],
            follow_ups: [],
          })),
        }),
        usage: { ...USAGE },
        model: 'fake-model',
        finishReason: 'stop',
      };
    }
    throw new Error('fake provider: unknown phase');
  }
}
