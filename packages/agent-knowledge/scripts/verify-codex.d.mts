export type Expected = { path: string; hash: string; value: string; skillProbe?: string; absent?: boolean; unavailable?: boolean; requireSkill?: boolean };
export function evaluateTrace(stdout: string, expected: Expected): {
  status: 'passed' | 'inconclusive';
  evidence: Record<string, boolean | string | null>;
  answer: string;
  record: any;
};
export function runProcess(command: string, args: string[], options: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv }): Promise<{
  exitCode: number | null; signal: string | null; timedOut: boolean; truncated: boolean; interrupted: string | null; spawnError: string | null; stdout: string; stderr: string;
}>;
export function prepareRun(outputDir: string, shouldStop?: () => boolean): Promise<{ runDir: string; workspace: string; configPath: string; sourceFile: string; value: string; skillProbe: string; hash: string }>;
export function main(argv?: string[]): Promise<number>;
