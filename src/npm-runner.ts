/** Shell-free launcher for npm scripts (Phase 9C).
 *
 *  Why: `spawn('npm', args, {shell: true})` triggers Node DEP0190 because arguments are concatenated into a shell command line.
 *  The Command Deck only passes literal strings today, but a shell on that path would turn any future dynamic argument into a
 *  command-injection vector. This helper runs npm as `node <npm-cli.js> ...` (no shell, args stay an argv array) and fails closed
 *  on anything outside a small allowlist of npm scripts.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** npm scripts the Command Deck may launch. */
export const ALLOWED_NPM_SCRIPTS: ReadonlySet<string> = new Set(['agent', 'browser', 'desktop', 'discover', 'notes', 'doctor']);

export interface Invocation { command: string; args: string[] }

export function findNpmCli(env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): string | null {
  const fromEnv = env.npm_execpath;
  if (fromEnv && /npm-cli\.c?js$/i.test(fromEnv) && existsSync(fromEnv)) return fromEnv;
  const nodeDir = dirname(execPath);
  const candidates = [
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),            // Windows installer layout
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js') // POSIX layout
  ];
  return candidates.find(existsSync) ?? null;
}

/** Build a shell-free invocation for `npm run <script>`; throws for anything not allowlisted or when npm cannot be located. */
export function npmRunInvocation(script: string, env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): Invocation {
  if (!ALLOWED_NPM_SCRIPTS.has(script)) throw new Error(`npm script not allowed from the launcher: ${JSON.stringify(script)}`);
  const cli = findNpmCli(env, execPath);
  if (!cli) throw new Error('npm-cli.js not found next to the running Node.js; run `npm run ' + script + '` manually');
  return { command: execPath, args: [cli, 'run', script] };
}

/** Same, for arbitrary npm sub-commands used by tooling/tests (no allowlist on the verb, still no shell). */
export function npmInvocation(args: string[], env: NodeJS.ProcessEnv = process.env, execPath: string = process.execPath): Invocation {
  const cli = findNpmCli(env, execPath);
  if (!cli) throw new Error('npm-cli.js not found next to the running Node.js');
  return { command: execPath, args: [cli, ...args] };
}
