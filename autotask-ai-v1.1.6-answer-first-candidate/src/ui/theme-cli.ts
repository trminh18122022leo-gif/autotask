import { runAppearanceStudio } from './appearance-cli.js';

export async function runThemeCli() {
  await runAppearanceStudio();
}

if (process.argv[1] && /(?:^|[\\/])theme-cli\.(?:ts|js)$/.test(process.argv[1])) {
  void runThemeCli();
}
