/** Lexical retrieval for a small local corpus. No model or database dependency. */
export interface SearchDocument {
  id: string;
  path: string;
  content: string;
}

export interface RankedDocument {
  id: string;
  score: number;
}

const MAX_QUERY_LENGTH = 4096;
const MAX_RESULTS = 100;
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'how', 'what', 'where',
  'and', 'or', 'for', 'with', 'which', 'does', 'do', 'on', 'by', 'from',
  '什么', '怎么', '如何', '哪些', '哪个', '哪里', '为何', '为什么', '是否',
  '一个', '有关', '相关', '以及', '可以', '使用', '中的', '的是',
  '请问', '关于', '需要', '查询', '查找', '实现', '处理', '代码', '项目',
]);

/** Lowercase Latin identifiers (including components), plus overlapping Han bigrams. */
export function tokenize(text: string): string[] {
  const terms: string[] = [];
  // Keep punctuation out of the index, but preserve a full identifier and its parts.
  const pieces = text.match(/[\p{Script=Han}]+|(?:(?!\p{Script=Han})[\p{L}\p{N}_])+/gu) ?? [];
  for (const piece of pieces) {
    if (/^\p{Script=Han}+$/u.test(piece)) {
      const chars = Array.from(piece);
      if (chars.length === 1) terms.push(chars[0]!);
      else for (let i = 0; i < chars.length - 1; i++) terms.push(chars[i]! + chars[i + 1]!);
      continue;
    }
    const whole = piece.toLowerCase();
    terms.push(whole);
    const parts = piece
      .replace(/([a-z\d])([A-Z])/g, '$1 $2')
      .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
      .split(/_+/)
      .flatMap((part) => part.split(/\s+/))
      .map((part) => part.toLowerCase())
      .filter(Boolean);
    for (const part of parts) if (part !== whole) terms.push(part);
  }
  return terms;
}

/**
 * Rank exact lexical matches with BM25-style document frequency and length
 * normalization, plus a small path boost. This scans the supplied corpus in
 * memory; callers should select an authorized, bounded corpus beforehand.
 */
export function rankDocuments(
  query: string,
  documents: SearchDocument[],
  limit: number,
): RankedDocument[] {
  if (typeof query !== 'string') throw new TypeError('query must be a string');
  if (query.length > MAX_QUERY_LENGTH) throw new RangeError('query is too long');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_RESULTS) {
    throw new RangeError(`limit must be an integer between 1 and ${MAX_RESULTS}`);
  }
  const queryTerms = [...new Set(tokenize(query).filter((term) => !STOP_WORDS.has(term)))];
  if (!queryTerms.length || !documents.length) return [];

  const frequency = new Map<string, number>();
  const indexed = documents.map((document) => {
    const tokens = tokenize(document.content);
    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
    const pathTerms = new Set(tokenize(document.path));
    for (const term of queryTerms) {
      if (counts.has(term) || pathTerms.has(term)) {
        frequency.set(term, (frequency.get(term) ?? 0) + 1);
      }
    }
    return { document, counts, pathTerms, length: tokens.length };
  });
  const averageLength = indexed.reduce((sum, entry) => sum + entry.length, 0) / indexed.length || 1;

  return indexed.map(({ document, counts, pathTerms, length }) => {
    let score = 0;
    for (const term of queryTerms) {
      const count = counts.get(term) ?? 0;
      const inPath = pathTerms.has(term);
      if (!count && !inPath) continue;
      const documentFrequency = frequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - documentFrequency + 0.5) / (documentFrequency + 0.5));
      const weightedCount = count + (inPath ? 1.5 : 0);
      score += idf * ((weightedCount * 2.2) / (weightedCount + 1.2 * (0.25 + 0.75 * length / averageLength)));
    }
    return { id: document.id, score };
  }).filter((result) => result.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en'))
    .slice(0, limit);
}
