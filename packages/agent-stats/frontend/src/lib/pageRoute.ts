import type { Page } from '../types';

export const pageHref = {
  overview: '#/overview',
  sessions: '#/sessions',
  journal: '#/journal',
  source: '#/source',
  knowledge: '#/knowledge',
} as const satisfies Record<Page, string>;

export function pageFromHash(hash: string): Page {
  switch (hash) {
    case pageHref.sessions:
      return 'sessions';
    case pageHref.journal:
      return 'journal';
    case pageHref.source:
      return 'source';
    case pageHref.knowledge:
      return 'knowledge';
    default:
      return 'overview';
  }
}
