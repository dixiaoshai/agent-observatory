import { SqliteStore } from '../src/storage/index.js';
import { sourceStorageContract } from './storage-contract.js';

sourceStorageContract('SQLite', async () => new SqliteStore(':memory:'));
