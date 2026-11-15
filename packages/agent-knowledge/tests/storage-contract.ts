import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Repositories, UnitOfWork } from '../src/application/ports.js';
import type { SourceState } from '../src/core/index.js';

/** Reuse this stage-one contract for future storage adapters. */
export function sourceStorageContract(name: string, create: () => Promise<{ repositories: Repositories; uow: UnitOfWork; close(): void }>) {
  const source: SourceState = { id: 'contract', owner_id: 'local:test', project_id: 'demo', root: '/synthetic', revision: 1, updated_at: '2026-11-08T00:00:00Z' };
  test(`${name}: atomic rollback and conditional source versions`, async () => {
    const store = await create();
    try {
      await assert.rejects(store.uow.run(async ({ sources }) => {
        await sources.save(source, null);
        throw new Error('abort');
      }), /abort/);
      assert.equal(await store.repositories.sources.get(source.id), null);
      await store.uow.run(({ sources }) => sources.save(source, null));
      await assert.rejects(store.uow.run(({ sources }) => sources.save(source, null)), /changed during scanning/);
      assert.equal((await store.repositories.sources.get(source.id))!.revision, 1);
    } finally { store.close(); }
  });
  test(`${name}: public reads wait until a transaction has committed or rolled back`, async () => {
    const store = await create();
    try {
      let release!: () => void;
      let inserted!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<void>((resolve) => { inserted = resolve; });
      const transaction = store.uow.run(async ({ sources }) => {
        await sources.save(source, null);
        inserted();
        await gate; // Only the contract test holds a transaction open.
        throw new Error('rollback');
      });
      await ready;
      const read = store.repositories.sources.get(source.id);
      release();
      await assert.rejects(transaction, /rollback/);
      assert.equal(await read, null);
    } finally { store.close(); }
  });
}
