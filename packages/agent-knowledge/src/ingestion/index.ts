import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import fsPromises, { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import ignore, { type Ignore } from 'ignore';

export interface SourceConfig {
  id: string;
  root: string;
  project_id: string;
  include_extensions?: string[];
  max_file_bytes?: number;
}

export interface ScannedFile {
  path: string;
  content: string;
  content_hash: string;
  git_commit: string | null;
}

export interface ScanResult {
  files: ScannedFile[];
  skipped: { path: string; reason: string }[];
}

const DEFAULT_EXTENSIONS = [
  '.md', '.markdown', '.txt', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonc', '.yaml', '.yml', '.toml', '.py', '.go', '.rs', '.java',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.rb', '.sh', '.bash', '.zsh',
  '.sql', '.html', '.css', '.scss', '.vue', '.svelte', '.xml', '.ini', '.conf',
];
const BLOCKED_DIRECTORIES = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'coverage', 'target', '__pycache__',
  '.git', '.hg', '.svn', '.knowrelay', '.venv', 'venv',
]);
const BLOCKED_EXTENSIONS = new Set([
  '.pem', '.key', '.p12', '.pfx', '.keystore', '.jks', '.crt', '.der', '.cer',
]);
const execFileAsync = promisify(execFile);

type RuleSet = { base: string; matcher: Ignore };

function isSensitive(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('.env') || lower.startsWith('credentials') ||
    lower.startsWith('secrets') || lower.startsWith('secret.') ||
    lower === '.npmrc' || lower === '.pypirc' || lower === '.netrc' ||
    lower === 'id_rsa' || lower === 'id_ed25519' || lower === 'id_ecdsa' ||
    /(?:^|[._-])(credential|credentials|secret|secrets|password|token)(?:[._-]|$)/.test(lower) ||
    BLOCKED_EXTENSIONS.has(path.extname(lower));
}

function isIgnored(relative: string, isDirectory: boolean, rules: RuleSet[]): boolean {
  let ignored = false;
  for (const { base, matcher } of rules) {
    const local = base ? relative.slice(base.length + 1) : relative;
    const result = matcher.test(isDirectory ? `${local}/` : local);
    if (result.ignored) ignored = true;
    else if (result.unignored) ignored = false;
  }
  return ignored;
}

async function gitCommit(root: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root, encoding: 'utf8', timeout: 5000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    const commit = stdout.trim();
    return /^[a-f0-9]{40,64}$/i.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

/** Scan only configured text files. Any I/O failure aborts the whole scan. */
export async function scanSource(config: SourceConfig): Promise<ScanResult> {
  if (!config.root || !path.isAbsolute(config.root)) throw new Error('Source root must be an absolute path');
  const rootInfo = await lstat(path.resolve(config.root));
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error('Source root must be a real directory');
  const root = await realpath(config.root);
  const directories = new Map<string, Stats>([[root, rootInfo]]);
  const sameIdentity = (left: Stats, right: Stats): boolean => left.dev === right.dev && left.ino === right.ino;
  // Recheck every ancestor, not just the final component protected by O_NOFOLLOW.
  async function verifyDirectories(directory: string): Promise<void> {
    const relative = path.relative(root, directory);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Path escaped source root');
    const chain = [root];
    let current = root;
    for (const part of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      chain.push(current);
    }
    for (const item of chain) {
      const expected = directories.get(item);
      const actual = await lstat(item);
      if (!expected || !actual.isDirectory() || actual.isSymbolicLink() ||
          !sameIdentity(expected, actual) || await realpath(item) !== item) {
        throw new Error(`Directory changed while scanning: ${item}`);
      }
    }
  }
  const maxBytes = config.max_file_bytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('max_file_bytes must be a positive integer');
  const extensions = new Set((config.include_extensions ?? DEFAULT_EXTENSIONS).map((ext) => {
    if (!/^\.[a-z0-9]+$/i.test(ext)) throw new Error(`Invalid file extension: ${ext}`);
    return ext.toLowerCase();
  }));
  const result: ScanResult = { files: [], skipped: [] };
  const commit = await gitCommit(root);

  async function walk(dir: string, relativeDir: string, parentRules: RuleSet[]): Promise<void> {
    await verifyDirectories(dir);
    const entries = await fsPromises.readdir(dir, { withFileTypes: true });
    await verifyDirectories(dir);
    entries.sort((a, b) => a.name.localeCompare(b.name));
    let rules = parentRules;
    const gitignoreEntry = entries.find((entry) => entry.name === '.gitignore');
    if (gitignoreEntry && !gitignoreEntry.isFile()) {
      throw new Error(`.gitignore must be a regular file: ${path.join(dir, '.gitignore')}`);
    }
    if (gitignoreEntry?.isFile()) {
      const handle = await open(path.join(dir, '.gitignore'), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`Not a regular file: ${path.join(dir, '.gitignore')}`);
        if (stat.size > maxBytes) throw new Error('.gitignore exceeds the configured file size limit');
        await verifyDirectories(dir);
        if (!sameIdentity(stat, await lstat(path.join(dir, '.gitignore')))) throw new Error('.gitignore changed while scanning');
        const text = await handle.readFile({ encoding: 'utf8' });
        await verifyDirectories(dir);
        if (!sameIdentity(stat, await lstat(path.join(dir, '.gitignore')))) throw new Error('.gitignore changed while scanning');
        rules = [...parentRules, { base: relativeDir, matcher: ignore().add(text) }];
      } finally {
        await handle.close();
      }
    }
    for (const entry of entries) {
      const relative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      await verifyDirectories(dir);
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        result.skipped.push({ path: relative, reason: 'symbolic link' });
        continue;
      }
      if (info.isDirectory()) {
        if (entry.name.startsWith('.') || isSensitive(entry.name) || BLOCKED_DIRECTORIES.has(entry.name.toLowerCase())) {
          result.skipped.push({ path: relative, reason: 'excluded directory' });
        } else if (isIgnored(relative, true, rules)) {
          result.skipped.push({ path: relative, reason: 'ignored' });
        } else {
          directories.set(full, info);
          await walk(full, relative, rules);
        }
        continue;
      }
      if (!info.isFile()) {
        result.skipped.push({ path: relative, reason: 'not a regular file' });
        continue;
      }
      if (isSensitive(entry.name)) {
        result.skipped.push({ path: relative, reason: 'sensitive file' });
        continue;
      }
      if (isIgnored(relative, false, rules)) {
        result.skipped.push({ path: relative, reason: 'ignored' });
        continue;
      }
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      if (info.size > maxBytes) {
        result.skipped.push({ path: relative, reason: 'size limit' });
        continue;
      }
      const handle = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new Error(`Not a regular file: ${full}`);
        await verifyDirectories(dir);
        if (!sameIdentity(info, stat) || await realpath(full) !== full) throw new Error(`File changed while opening: ${full}`);
        if (stat.size > maxBytes) {
          result.skipped.push({ path: relative, reason: 'size limit' });
          continue;
        }
        // Bound the read even if a file grows after its size was checked.
        const buffer = Buffer.allocUnsafe(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
          if (bytesRead === 0) break;
          length += bytesRead;
        }
        const bytes = buffer.subarray(0, length);
        if (bytes.length !== stat.size) throw new Error(`File changed while reading: ${full}`);
        await verifyDirectories(dir);
        if (!sameIdentity(stat, await lstat(full)) || await realpath(full) !== full) throw new Error(`File changed while reading: ${full}`);
        let content: string;
        try {
          content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          result.skipped.push({ path: relative, reason: 'invalid UTF-8' });
          continue;
        }
        if (content.includes('\0')) {
          result.skipped.push({ path: relative, reason: 'binary file' });
          continue;
        }
        result.files.push({
          path: relative, content,
          content_hash: createHash('sha256').update(bytes).digest('hex'),
          git_commit: commit,
        });
      } finally {
        await handle.close();
      }
    }
  }
  await walk(root, '', []);
  return result;
}
