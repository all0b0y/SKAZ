const path = require('node:path');

/** Test entry only: production deliberately drops inherited Python configuration. */
function smokeBackendOptions(root, command, options, fixture) {
  if (command !== path.join(root, 'backend', '.venv', 'bin', 'python')) return options;
  const knownFixture = path.join(root, 'scripts', 'fake-soniox');
  if ((fixture && fixture !== knownFixture) || (options.env.SKAZ_SMOKE_FAKE_SONIOX && fixture !== knownFixture)) {
    throw new Error('Smoke Soniox fixture is missing or not the repository fixture; refusing backend launch.');
  }
  // A shared virtualenv can point its editable install at another checkout. Always test this one.
  const source = path.join(root, 'backend', 'src');
  return { ...options, env: { ...options.env, PYTHONPATH: fixture ? [fixture, source].join(path.delimiter) : source } };
}

module.exports = { smokeBackendOptions };
