import assert from 'node:assert/strict';
import test from 'node:test';
import helpers from '../.github/scripts/contract-ci.cjs';

const { strictVersionValue, changeMode, assertGate, select } = helpers;
const skills = ['igapyon-miku-scm', 'igapyon-github-writer'];
const files = {
  package: 'package.json',
  miku: 'skills/igapyon-miku-scm/scripts/miku-scm-run.mjs',
  writer: 'skills/igapyon-github-writer/scripts/github-writer-workflow-manifest.mjs',
};

function versionTexts(number = '4') {
  return new Map([
    [files.package, JSON.stringify({ name: 'miku-scm-skills', version: `1.20261112.${number}`, scripts: { test: 'node test.mjs' } }, null, 2) + '\n'],
    [files.miku, `export const PRODUCT_VERSION = "1.20261112.${number}";\nexport function run() {}\n`],
    [files.writer, `export const PRODUCT_VERSION = "1.20261112.${number}";\nexport function write() {}\n`],
  ]);
}

function changed(paths) { return paths.map((filename) => ({ filename, status: 'modified' })); }
function blobs(base = versionTexts('3'), head = versionTexts()) {
  return new Map([...base].flatMap(([file, text]) => [[`base:${file}`, text], [`head:${file}`, head.get(file)]]));
}
function apiForContent(content, { failAt, pulls = [] } = {}) {
  let pullIndex = 0;
  return {
    github: {
      rest: {
        repos: { getContent: async ({ path, ref }) => {
          if (`${ref}:${path}` === failAt) throw new Error('contents API unavailable');
          const text = content.get(`${ref}:${path}`);
          if (text === undefined) throw new Error(`missing blob ${ref}:${path}`);
          return { data: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } };
        } },
        pulls: { get: async () => ({ data: pulls[pullIndex++] ?? pulls.at(-1) }), listFiles: 'files' },
      },
    },
    pullCalls: () => pullIndex,
  };
}

for (const skill of skills) test(`${skill} selector keeps strict version-only evidence and safe full-check fallbacks`, async () => {
  const fake = apiForContent(blobs());
  assert.equal(await changeMode({ ...fake, repo: {}, files: changed(Object.values(files)), expectedCount: 3,
    baseSha: 'base', headSha: 'head', skill }), 'versions');

  const mixed = versionTexts();
  mixed.set(files.miku, `${mixed.get(files.miku)}// implementation change\n`);
  assert.equal(await changeMode({ ...apiForContent(blobs(versionTexts('3'), mixed)), repo: {}, files: changed([files.miku]),
    expectedCount: 1, baseSha: 'base', headSha: 'head', skill }), 'full');

  const scriptsChanged = versionTexts();
  scriptsChanged.set(files.package, scriptsChanged.get(files.package).replace('node test.mjs', 'node changed.mjs'));
  assert.equal(await changeMode({ ...apiForContent(blobs(versionTexts('3'), scriptsChanged)), repo: {}, files: changed([files.package]),
    expectedCount: 1, baseSha: 'base', headSha: 'head', skill }), 'full');

  assert.equal(await changeMode({ ...fake, repo: {}, files: [{ filename: files.miku, previous_filename: 'skills/igapyon-miku-scm/scripts/old.mjs', status: 'renamed' }],
    expectedCount: 1, baseSha: 'base', headSha: 'head', skill }), 'full');

  const mismatched = versionTexts();
  mismatched.set(files.writer, mismatched.get(files.writer).replace('1.20261112.4', '1.20261112.3'));
  assert.equal(await changeMode({ ...apiForContent(blobs(versionTexts('3'), mismatched)), repo: {}, files: changed(Object.values(files)),
    expectedCount: 3, baseSha: 'base', headSha: 'head', skill }), 'full');
  assert.equal(await changeMode({ ...apiForContent(blobs(), { failAt: `head:${files.writer}` }), repo: {}, files: changed(Object.values(files)),
    expectedCount: 3, baseSha: 'base', headSha: 'head', skill }), 'full');

  assert.equal(await changeMode({ github: fake.github, repo: {}, files: [{ filename: 'README.md' }], expectedCount: 2,
    baseSha: 'base', headSha: 'head', skill }), 'full');
  assert.equal(await changeMode({ github: fake.github, repo: {}, files: changed(['README.md']), expectedCount: 1,
    baseSha: 'base', headSha: 'head', skill }), 'none');
  assert.equal(await changeMode({ github: fake.github, repo: {}, files: changed(['.github/workflows/release-build.yml']), expectedCount: 1,
    baseSha: 'base', headSha: 'head', skill }), 'full');
});

test('version-only selection accepts one aligned version source by itself', async () => {
  const base = versionTexts();
  base.set(files.package, base.get(files.package).replace('1.20261112.4', '1.20261112.3'));
  assert.equal(await changeMode({ ...apiForContent(blobs(base, versionTexts())), repo: {}, files: changed([files.package]),
    expectedCount: 1, baseSha: 'base', headSha: 'head', skill: 'igapyon-miku-scm' }), 'versions');
});

test('strict version readers normalize only the version value', () => {
  const source = 'prefix\nexport const PRODUCT_VERSION = "1.20261112.4";\nsuffix\n';
  assert.deepEqual(strictVersionValue(files.miku, source), {
    version: '1.20261112.4', normalized: 'prefix\nexport const PRODUCT_VERSION = "<VERSION>";\nsuffix\n',
  });
  assert.throws(() => strictVersionValue(files.miku, `${source}${source}`), /one version literal/);
  assert.throws(() => strictVersionValue(files.package, '{'), /Invalid package.json/);
});

test('required gate propagates failed, cancelled, skipped, and malformed jobs', () => {
  const needs = (mode, contract, versions, selection = 'success') => ({
    select: { result: selection, outputs: { mode, required: String(mode !== 'none') } },
    contract: { result: contract }, versions: { result: versions },
  });
  assert.doesNotThrow(() => assertGate(needs('none', 'skipped', 'skipped')));
  assert.doesNotThrow(() => assertGate(needs('versions', 'skipped', 'success')));
  assert.doesNotThrow(() => assertGate(needs('full', 'success', 'skipped')));
  for (const result of ['failure', 'cancelled', 'skipped', 'timed_out']) {
    assert.throws(() => assertGate(needs('versions', 'skipped', result)));
    assert.throws(() => assertGate(needs('full', result, 'skipped')));
  }
  assert.throws(() => assertGate(needs('none', 'success', 'skipped')));
  assert.throws(() => assertGate(needs('versions', 'success', 'success')));
  assert.throws(() => assertGate(needs('full', 'success', 'success')));
  assert.throws(() => assertGate(needs('none', 'skipped', 'skipped', 'failure')));
});

test('PR selection binds file evidence to an unchanged base and head; dispatch always runs full', async () => {
  const outputs = [];
  const content = blobs();
  const pr = { head: { sha: 'head' }, base: { sha: 'base' }, changed_files: 3 };
  const api = apiForContent(content, { pulls: [pr, pr] });
  api.github.paginate = async (_endpoint, args) => {
    assert.equal(args.pull_number, 1);
    assert.equal(args.per_page, 100);
    return changed(Object.values(files));
  };
  await select({ context: { eventName: 'pull_request', repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 1, head: { sha: 'head' }, base: { sha: 'base' } } } },
    core: { setOutput: (...args) => outputs.push(args) }, github: api.github }, 'igapyon-miku-scm');
  assert.deepEqual(outputs, [['required', 'true'], ['mode', 'versions']]);
  assert.equal(api.pullCalls(), 2);

  const moved = apiForContent(content, { pulls: [pr, { ...pr, head: { sha: 'moved' } }] });
  moved.github.paginate = async () => changed(Object.values(files));
  await assert.rejects(select({ context: { eventName: 'pull_request', repo: { owner: 'owner', repo: 'repo' }, payload: { pull_request: { number: 1, head: { sha: 'head' }, base: { sha: 'base' } } } },
    core: { setOutput() {} }, github: moved.github }, 'igapyon-github-writer'), /PR changed/);

  const dispatch = [];
  await select({ context: { eventName: 'workflow_dispatch' }, core: { setOutput: (...args) => dispatch.push(args) } }, 'igapyon-github-writer');
  assert.deepEqual(dispatch, [['required', 'true'], ['mode', 'full']]);
});
