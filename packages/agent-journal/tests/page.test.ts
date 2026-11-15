import test from 'node:test';
import assert from 'node:assert/strict';
import { JournalError } from '../src/errors.ts';
import { pageFingerprint, validatePage, type Page } from '../src/trace/page.ts';
import { codexEvent, deletionEvent, fixturePage, loadFixture, pageOf } from './helpers.ts';

const ARCHIVE = '00000000-0000-4000-8000-000000000001';
const OPTIONS = { after: 0, archiveId: ARCHIVE, allowedProjects: ['fixture'], maxEvents: 100 };
const isInvalidPage = (error: unknown) => error instanceof JournalError && error.code === 'INVALID_PAGE';

/** Page mixing in-scope and out-of-scope projects (including a foreign deletion marker). */
function mixedPage(options: { malformedForeign?: boolean } = {}): Page {
  const malformedForeign = options.malformedForeign ?? true;
  const foreignContent = codexEvent({
    seq: 2, kind: 'message.user', projectId: 'other', line: 102,
    data: malformedForeign ? { injected: 'unknown metadata field' } : {},
  });
  const foreignDeletion = deletionEvent({ seq: 4 });
  foreignDeletion.project_id = 'other';
  return pageOf([
    codexEvent({ seq: 1, kind: 'session.started', projectId: 'fixture', line: 101 }),
    foreignContent,
    codexEvent({ seq: 3, kind: 'turn.completed', projectId: 'fixture', line: 103 }),
    foreignDeletion,
  ], { after: 0, next: 4 });
}

test('vendored conformance fixtures exist in this module', () => {
  const manifest = loadFixture('manifest.json') as { fixtures: Array<{ file: string; valid: boolean }> };
  assert.ok(manifest.fixtures.length >= 20);
});

test('accepts valid content, deletion and content_ref pages', () => {
  const content = validatePage(fixturePage('valid/content-page-1.json'), OPTIONS);
  assert.equal(content.events.length, 6);
  assert.equal(content.events[1]?.kind, 'message.user');

  const deletion = validatePage(fixturePage('valid/content-deletion-page.json'), { ...OPTIONS, after: 6 });
  assert.equal(deletion.events[0]?.kind, 'session.deleted');

  const ref = validatePage(fixturePage('valid/content-ref-page.json'), OPTIONS);
  assert.equal(ref.events[0]?.kind, 'tool.returned');

  assert.equal(pageFingerprint(content), pageFingerprint(validatePage(fixturePage('valid/content-page-1.json'), OPTIONS)));
});

test('metadata pages are not accepted by the content-only journal', () => {
  assert.throws(() => validatePage(fixturePage('valid/metadata-empty-page.json'), OPTIONS), (error: unknown) => error instanceof JournalError);
});

test('accepts session.title revisions as display metadata', () => {
  const content = validatePage(pageOf([
    codexEvent({ seq: 1, kind: 'session.started', line: 101, data: { title: 'First name' } }),
    codexEvent({ seq: 2, kind: 'session.title', line: 102, data: { title: 'Model given name' } }),
    codexEvent({ seq: 3, kind: 'message.user', line: 103, data: { title: 'Prompt' } }),
  ]), OPTIONS);
  assert.deepEqual(content.events.map((event) => event.kind), ['session.started', 'session.title', 'message.user']);

  const unexpected = pageOf([
    codexEvent({ seq: 1, kind: 'session.title', line: 101, data: { title: 'ok', cwd: '/demo' } }),
  ]);
  assert.throws(() => validatePage(unexpected, OPTIONS), isInvalidPage);
});

test('all invalid fixtures are rejected as permanent errors', () => {
  const manifest = loadFixture('manifest.json') as { fixtures: Array<{ file: string; valid: boolean }> };
  for (const fixture of manifest.fixtures.filter((entry) => !entry.valid)) {
    const page = fixturePage(fixture.file);
    const after = page.after_cursor === 6 ? 6 : 0;
    let error: unknown;
    try {
      validatePage(page, { ...OPTIONS, after });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error instanceof JournalError, fixture.file);
    assert.equal(error.klass, 'permanent', fixture.file);
    assert.ok(['INVALID_PAGE', 'ARCHIVE_CHANGED'].includes(error.code), `${fixture.file}: ${error.code}`);
  }
});

test('page bounds and archive identity are enforced', () => {
  const page = fixturePage('valid/content-page-1.json');
  assert.throws(() => validatePage(page, { ...OPTIONS, maxEvents: 3 }), isInvalidPage);
  assert.throws(() => validatePage(page, { ...OPTIONS, archiveId: 'other-archive' }),
    (error: unknown) => error instanceof JournalError && error.code === 'ARCHIVE_CHANGED');
  assert.throws(() => validatePage(page, { ...OPTIONS, after: 6 }), isInvalidPage);
});

test('projects is a consumption scope: out-of-scope events are skipped, not rejected', () => {
  const filtered = validatePage(mixedPage(), OPTIONS);
  assert.deepEqual(filtered.events.map((event) => event.archive_seq), [1, 3]);
  assert.ok(filtered.events.every((event) => event.project_id === 'fixture'));
  assert.equal(filtered.after_cursor, 0);
  assert.equal(filtered.next_cursor, 4);
  assert.equal(filtered.has_more, false);
  // Filtering is deterministic: a verbatim replay yields the same page fingerprint.
  assert.equal(pageFingerprint(filtered), pageFingerprint(validatePage(mixedPage(), OPTIONS)));
  // The scope is symmetric: another allowed project keeps only its own events.
  const other = validatePage(mixedPage({ malformedForeign: false }), { ...OPTIONS, allowedProjects: ['other'] });
  assert.deepEqual(other.events.map((event) => event.archive_seq), [2, 4]);
  // ...and once a project is in scope its events are deep-validated again.
  assert.throws(() => validatePage(mixedPage(), { ...OPTIONS, allowedProjects: ['other'] }), isInvalidPage);
});

test('envelope checks still run for skipped out-of-scope events', () => {
  const badIdentity = mixedPage();
  badIdentity.events[1]!.event_id = 'not-a-sha256';
  assert.throws(() => validatePage(badIdentity, OPTIONS), isInvalidPage);

  const duplicate = mixedPage();
  duplicate.events[1]!.event_id = duplicate.events[0]!.event_id;
  assert.throws(() => validatePage(duplicate, OPTIONS), isInvalidPage);

  const beyond = mixedPage();
  beyond.events[1]!.archive_seq = 99;
  assert.throws(() => validatePage(beyond, OPTIONS), isInvalidPage);

  const unordered = mixedPage();
  unordered.events[1]!.archive_seq = 0;
  assert.throws(() => validatePage(unordered, OPTIONS), isInvalidPage);
});
