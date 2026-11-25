/** CLI Runner for Phase 3B — Real-Model Practice Benchmark.
 * Never uses a scripted responder; outputs honest NOT TESTED status when no BYOK API profile is configured.
 */
import { runRealModelPracticeBenchmark } from '../src/evaluation/real-model-benchmark.js';
import { redactSecrets } from '../src/security/redact.js';

async function main(): Promise<void> {
  const profileArgs = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const result = await runRealModelPracticeBenchmark(profileArgs.length ? profileArgs : undefined);
  console.log(redactSecrets(JSON.stringify(result, null, 2)));
}

main().catch(err => {
  console.error(redactSecrets(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
