/** Offline official-contract conformance. External sources are never downloaded or vendored. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const UPSTREAM = '8dd8deee8d115b3ad4cea6ddc615118ba670ee36';
const DEPENDENCIES = {
  'forge-std': '1eea5bae12ae557d589f9f0f0edae2faa47cb262',
  'openzeppelin-contracts': '69c8def5f222ff96f2b5beff05dfba996368aa79',
  'openzeppelin-contracts-upgradeable': 'fa525310e45f91eb20a6d3baa2644be8e0adba31',
};
const EXPECTED_TESTS = [
  'test_acceptsSignedPayloadAndReturnsExactSigner()',
  'test_rejectsTamperedSignature()',
  'test_rejectsTamperedPayload()',
  'test_rejectsUnknownSigner()',
  'test_rejectsExpiredSignerAtExactExpiry()',
  'test_rejectsInsufficientFee()',
];
const fail = (code: string): never => { throw new Error(code); };
// Exclude RPC URLs, wallet/provider secrets and inherited Forge/Git configuration.
const environment: NodeJS.ProcessEnv = {
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
};
function run(binary: string, args: string[], cwd: string, code: string, timeout = 15000): string {
  const result = spawnSync(binary, args, {
    cwd, env: environment, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], shell: false,
  });
  if (result.error || result.signal || result.status !== 0) fail(code);
  return result.stdout.trim();
}
function git(directory: string, args: string[]): string {
  return run('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-C', directory, ...args], directory, 'GIT_VALIDATION_FAILED');
}
function validateCheckout(directory: string, sha: string): void {
  if (realpathSync(git(directory, ['rev-parse', '--show-toplevel'])) !== directory) fail('CHECKOUT_ROOT_REQUIRED');
  if (git(directory, ['rev-parse', 'HEAD']) !== sha) fail('CHECKOUT_PIN_MISMATCH');
  if (git(directory, ['status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none']) !== '') fail('CHECKOUT_NOT_CLEAN');
}
function absoluteDirectory(value: string | undefined): string {
  if (!value || !isAbsolute(value)) fail('ABSOLUTE_CHECKOUT_REQUIRED');
  const path = realpathSync(value!);
  if (!statSync(path).isDirectory()) fail('CHECKOUT_DIRECTORY_REQUIRED');
  return path;
}
function main(): void {
  const { values } = parseArgs({ options: { checkout: { type: 'string' }, forge: { type: 'string' } }, strict: true, allowPositionals: false });
  const checkout = absoluteDirectory(values.checkout);
  if (values.forge && !isAbsolute(values.forge)) fail('ABSOLUTE_FORGE_REQUIRED');
  const forge = values.forge ? realpathSync(values.forge) : 'forge';
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const evm = join(checkout, 'lazer/contracts/evm');
  validateCheckout(checkout, UPSTREAM);
  for (const [name, sha] of Object.entries(DEPENDENCIES)) {
    const path = join(evm, 'lib', name);
    if (realpathSync(path) !== path) fail('DEPENDENCY_SYMLINK_REJECTED');
    validateCheckout(path, sha);
    const tree = git(checkout, ['ls-tree', 'HEAD', `lazer/contracts/evm/lib/${name}`]);
    if (!tree.startsWith(`160000 commit ${sha}\t`)) fail('DEPENDENCY_GITLINK_MISMATCH');
  }
  const forgeVersion = run(forge, ['--version'], root, 'FORGE_UNAVAILABLE').split('\n')[0] ?? '';
  if (!/^forge Version: [a-zA-Z0-9.+-]+$/.test(forgeVersion)) fail('FORGE_VERSION_INVALID');
  const build = mkdtempSync(join(tmpdir(), 'sbx-evm-conformance-'));
  const quote = (value: string) => JSON.stringify(value);
  const remappings = [
    `pyth-external/=${evm}/src/`,
    `forge-std/=${evm}/lib/forge-std/src/`,
    `@openzeppelin/contracts/=${evm}/lib/openzeppelin-contracts/contracts/`,
    `@openzeppelin/contracts-upgradeable/=${evm}/lib/openzeppelin-contracts-upgradeable/contracts/`,
  ];
  // Fresh config prevents project/global settings enabling FFI, forks or alternate compiler settings.
  const config = join(build, 'foundry.toml');
  writeFileSync(config, [
    '[profile.default]', `src = ${quote(join(root, 'tests/evm'))}`, `test = ${quote(join(root, 'tests/evm'))}`,
    `out = ${quote(join(build, 'out'))}`, `cache_path = ${quote(join(build, 'cache'))}`,
    'libs = []', 'auto_detect_remappings = false', 'ffi = false', 'fs_permissions = []',
    `remappings = [${remappings.map(quote).join(',')}]`,
  ].join('\n') + '\n', { flag: 'wx', mode: 0o600 });
  const output = run(forge, [
    'test', '--root', build, '--config-path', config, '--offline', '--use', '0.8.23',
    '--evm-version', 'paris', '--optimize', 'true', '--optimizer-runs', '100000',
    '--match-contract', '^PythVerifierConformance$', '--json',
  ], build, 'CONFORMANCE_EXECUTION_FAILED', 120000);
  const suites = JSON.parse(output) as Record<string, { test_results?: Record<string, { status?: string }> }>;
  if (!suites || typeof suites !== 'object' || Array.isArray(suites)) fail('CONFORMANCE_REPORT_INVALID');
  const entries = Object.values(suites);
  if (entries.length !== 1 || !entries[0]?.test_results) fail('CONFORMANCE_SUITE_MISSING');
  const tests = entries[0]!.test_results!;
  if (Object.keys(tests).length !== EXPECTED_TESTS.length || EXPECTED_TESTS.some(name => tests[name]?.status !== 'Success')) fail('CONFORMANCE_TESTS_NOT_PASSED');
  // Revalidate inputs after compilation/execution; no broad cleanup or checkout mutation.
  validateCheckout(checkout, UPSTREAM);
  for (const [name, sha] of Object.entries(DEPENDENCIES)) validateCheckout(join(evm, 'lib', name), sha);
  console.log(JSON.stringify({ status: 'PASS', scope: 'ISOLATED_OFFICIAL_CONTRACT_CONFORMANCE', upstream: UPSTREAM,
    dependencies: DEPENDENCIES, forge: forgeVersion, compiler: '0.8.23', testsPassed: EXPECTED_TESTS.length,
    network: 'NOT_USED', productionPublication: 'NOT_PERFORMED' }));
}
try { main(); } catch (error) {
  const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'CONFORMANCE_PREREQUISITE_OR_REPORT_INVALID';
  console.error(JSON.stringify({ status: 'FAIL', code })); process.exitCode = 1;
}
