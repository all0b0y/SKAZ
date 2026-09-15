const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const wrapperPath = path.join(__dirname, 'main.cjs');
const wrapperSource = fs.readFileSync(wrapperPath, 'utf8');

function executeWrapper(requested, setPath) {
  const paths = new Map();
  const exits = [];
  let productionImported = false;
  const app = {
    exit(code) {
      exits.push(code);
    },
    getPath(name) {
      return paths.get(name);
    },
    setPath(name, value) {
      setPath(name, value, paths);
    },
  };
  const sandbox = {
    __dirname,
    console: { error() {}, log() {} },
    process: { env: { AUDIOHELPER_OPTIN_SMOKE_USER_DATA: requested } },
    require(specifier) {
      if (specifier === 'electron') return { app };
      if (specifier === 'node:fs') return fs;
      if (specifier === 'node:path') return path;
      if (specifier.endsWith(path.join('dist', 'main', 'main.js'))) {
        productionImported = true;
        return {};
      }
      throw new Error(`unexpected require: ${specifier}`);
    },
  };

  vm.runInNewContext(wrapperSource, sandbox, { filename: wrapperPath });
  return { exits, productionImported };
}

test('refuses before production import when the session directory cannot be created', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audiohelper-optin-refuse-'));
  try {
    fs.writeFileSync(path.join(profile, 'session'), 'not a directory');
    const result = executeWrapper(profile, (name, value, paths) => {
      paths.set(name, value);
    });

    assert.deepEqual(result.exits, [97]);
    assert.equal(result.productionImported, false);
    assert.equal(fs.existsSync(path.join(profile, 'data', 'audiohelper.sqlite3')), false);
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test('refuses before production import when Electron rejects userData relocation', () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'audiohelper-optin-userdata-refuse-'));
  try {
    assert.doesNotThrow(() => {
      const result = executeWrapper(profile, (name, value, paths) => {
        if (name === 'userData') throw new Error('relocation rejected');
        paths.set(name, value);
      });
      assert.deepEqual(result.exits, [97]);
      assert.equal(result.productionImported, false);
    });
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
