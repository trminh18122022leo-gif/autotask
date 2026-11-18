import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

test('All PowerShell scripts in scripts/ parse without syntax errors', () => {
  if (process.platform !== 'win32') return;

  const scriptsDir = resolve('scripts');
  const files = readdirSync(scriptsDir).filter(f => f.endsWith('.ps1'));

  assert.ok(files.length >= 2, 'Should have at least 2 powershell scripts');

  for (const file of files) {
    const fullPath = join(scriptsDir, file);
    // Use PowerShell's parser API to validate syntax without executing
    const psCmd = `
      $err = $null
      [System.Management.Automation.Language.Parser]::ParseFile("${fullPath.replace(/\\/g, '/')}", [ref]$null, [ref]$err)
      if ($err.Count -gt 0) {
        $err | ForEach-Object { "$($_.Extent.StartLineNumber): $($_.Message)" }
        exit 1
      }
      exit 0
    `;

    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command', psCmd], {
        encoding: 'utf8',
        timeout: 8000
      });
    } catch (err: any) {
      assert.fail(`PowerShell script syntax error in ${file}:\n${err.stdout || err.stderr || err.message}`);
    }
  }
});
