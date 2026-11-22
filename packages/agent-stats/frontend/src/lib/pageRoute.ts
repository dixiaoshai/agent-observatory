import type { Page } from '../types';

export const pageHref = {
  overview: '#/overview',
  sessions: '#/sessions',
  source: '#/source',
} as const satisfies Record<Page, string>;

export function pageFromHash(hash: string): Page {
  switch (hash) {
    case pageHref.sessions:
      return 'sessions';
    case pageHref.source:
      return 'source';
    default:
      return 'overview';
  }
}
