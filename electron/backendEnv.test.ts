import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: true, getVersion: () => '0.3.1', getPath: () => '/tmp/skaz-env-test' } }));

describe('backend environment (L3)', () => {
  const shell = {
    PATH: '/usr/bin', HOME: '/Users/me', LANG: 'ru_RU.UTF-8', LC_ALL: 'ru_RU.UTF-8', HTTPS_PROXY: 'http://proxy:3128',
    SSL_CERT_FILE: '/etc/ca.pem', HF_HOME: '/models', OPENAI_API_KEY: 'sk-from-shell', AWS_SECRET_ACCESS_KEY: 'x',
    GITHUB_TOKEN: 'ghp_x', SKAZ_ALLOWED_ORIGINS: 'http://evil', SKAZ_ALLOW_ENV_KEYS: '1', UV_CACHE_DIR: '/uv',
    PYTHONHOME: '/elsewhere',
  };

  it('the installed app passes system, network and backend settings only — no shell secrets', async () => {
    const { backendEnvironment } = await import('./backend');
    const env = backendEnvironment(shell, true);
    expect(env).toEqual({
      PATH: '/usr/bin', HOME: '/Users/me', LANG: 'ru_RU.UTF-8', LC_ALL: 'ru_RU.UTF-8', HTTPS_PROXY: 'http://proxy:3128',
      SSL_CERT_FILE: '/etc/ca.pem', HF_HOME: '/models',
    });
  });

  it('a development run also passes uv and SKAZ_* switches, and provider keys only when the fallback is on', async () => {
    const { backendEnvironment } = await import('./backend');
    const dev = backendEnvironment(shell, false);
    expect(dev).toMatchObject({ UV_CACHE_DIR: '/uv', SKAZ_ALLOWED_ORIGINS: 'http://evil', OPENAI_API_KEY: 'sk-from-shell' });
    expect(dev).not.toHaveProperty('GITHUB_TOKEN');
    expect(dev).not.toHaveProperty('PYTHONHOME');
    const off = backendEnvironment({ ...shell, SKAZ_ALLOW_ENV_KEYS: '0' }, false);
    expect(off).not.toHaveProperty('OPENAI_API_KEY');
  });
});
