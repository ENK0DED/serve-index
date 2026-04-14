import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';

import { serveIndex } from '../src/index.js';
import type { ServeIndexOptions } from '../src/types.js';

const makeTempDir = async () => mkdtemp(path.join(os.tmpdir(), 'serve-index-'));

const mountServeIndex = (root: string, options: ServeIndexOptions = {}) =>
  serveIndex(root, { rewriteRequestPath: (pathname) => pathname.replace(/^\/assets/, '') || '/', ...options });

const requireHeader = (value: string | null | undefined, name: string) => {
  expect(value).toBeTruthy();

  if (!value) {
    throw new Error(`Missing ${name} header`);
  }

  return value;
};

describe('@enk0ded/serve-index', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.splice(0).map(async (dir) => rm(dir, { force: true, recursive: true })));
  });

  test('renders a directory listing', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/', { headers: { Accept: 'text/html' } });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('hello.txt');
  });

  test('throws when root is empty', () => {
    expect(() => serveIndex('')).toThrow('serveIndex() root path required');
  });

  test('responds to OPTIONS with allowed methods', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/', { method: 'OPTIONS' });
    expect(response.status).toBe(200);
    expect(response.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
  });

  test('passes through non-GET/HEAD methods to downstream handlers', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const postResponse = await app.request('http://example.test/assets/', { method: 'POST' });
    expect(postResponse.status).toBe(404);

    const postApp = new Hono();
    postApp.use('/assets/*', mountServeIndex(root));
    postApp.post('/assets/*', (c) => c.text('post handler', 200));
    const postHandledResponse = await postApp.request('http://example.test/assets/', { method: 'POST' });
    expect(postHandledResponse.status).toBe(200);
    expect(await postHandledResponse.text()).toBe('post handler');
  });

  test('falls through to next handler for missing files', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/missing.txt');
    expect(response.status).toBe(404);
  });

  test('falls back to text/html for unsupported Accept types', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/', { headers: { Accept: 'application/xml' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  test('rejects null bytes in the path', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/%00');
    expect(response.status).toBe(400);
  });

  test('rejects rewrite escapes outside the root', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    cleanupDirs.push(root, outside);
    await writeFile(path.join(outside, 'outside.txt'), 'top secret');

    const app = new Hono();
    app.use('/assets/*', serveIndex(root, { rewriteRequestPath: () => '/../outside.txt' }));

    const response = await app.request('http://example.test/assets/anything');
    expect(response.status).toBe(403);
  });

  test('serves files with GET and returns correct body', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/hello.txt');
    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(await response.text()).toBe('hello world');
  });

  test('serves files with HEAD and correct content-length', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/hello.txt', { method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('11');
    expect(await response.text()).toBe('');
  });

  test('returns 304 for If-None-Match with matching ETag', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const initial = await app.request('http://example.test/assets/hello.txt');
    const etag = requireHeader(initial.headers.get('etag'), 'etag');
    await initial.text();

    const response = await app.request('http://example.test/assets/hello.txt', { headers: { 'If-None-Match': etag } });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
  });

  test('returns 304 for If-Modified-Since with matching date', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const initial = await app.request('http://example.test/assets/hello.txt');
    const lastModified = requireHeader(initial.headers.get('last-modified'), 'last-modified');
    await initial.text();

    const response = await app.request('http://example.test/assets/hello.txt', { headers: { 'If-Modified-Since': lastModified } });
    expect(response.status).toBe(304);
  });

  test('serves byte range requests', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/hello.txt', { headers: { Range: 'bytes=0-4' } });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 0-4/11');
    expect(await response.text()).toBe('hello');
  });

  test('respects If-Range with matching ETag', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const initial = await app.request('http://example.test/assets/hello.txt');
    const etag = requireHeader(initial.headers.get('etag'), 'etag');
    await initial.text();

    const response = await app.request('http://example.test/assets/hello.txt', { headers: { 'If-Range': etag, Range: 'bytes=6-10' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('world');
  });

  test('ignores range when If-Range ETag is stale', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/hello.txt', { headers: { 'If-Range': '"stale"', Range: 'bytes=6-10' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello world');
  });

  test('returns 416 for unsatisfiable byte ranges', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/hello.txt', { headers: { Range: 'bytes=99-120' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */11');
  });

  test('returns empty body for HEAD directory listings', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/', { headers: { Accept: 'text/html' }, method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('');
  });

  test('returns JSON directory listings', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/', { headers: { Accept: 'application/json' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(['nested', 'hello.txt']);
  });

  test('supports custom templates and filters', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'hello.txt'), 'hello world');
    await writeFile(path.join(root, 'nested', 'keep.txt'), 'keep');
    await writeFile(path.join(root, 'nested', 'skip.txt'), 'skip');

    const app = new Hono();
    app.use(
      '/assets/*',
      mountServeIndex(root, {
        filter: (filename) => filename !== 'skip.txt',
        template: (locals) =>
          JSON.stringify({
            files: locals.fileList.map((file) => file.name),
            host: locals.host,
            styleIncluded: locals.style.length > 0,
            viewName: locals.renderContext.viewName,
          }),
      }),
    );

    const response = await app.request('http://example.test/assets/nested/?view=details', { headers: { Accept: 'text/html' } });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('"files":["..","keep.txt"]');
    expect(body).toContain('"styleIncluded":true');
    expect(body).toContain('"viewName":"details"');
    expect(body).not.toContain('skip.txt');
  });

  test('short-circuits HEAD directory listings before custom filtering work', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use(
      '/assets/*',
      mountServeIndex(root, {
        filter: () => {
          throw new Error('HEAD directory listing should not enumerate files');
        },
      }),
    );

    const response = await app.request('http://example.test/assets/', { headers: { Accept: 'application/json' }, method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).toBe('');
  });

  test('blocks symlink escapes outside the root', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    cleanupDirs.push(root, outside);

    const outsideFile = path.join(outside, 'secret.txt');
    const linkPath = path.join(root, 'secret.txt');
    await writeFile(outsideFile, 'top secret');
    await symlink(outsideFile, linkPath);

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/secret.txt');
    expect(response.status).toBe(403);
  });

  test('blocks directory symlink escapes outside the root', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    cleanupDirs.push(root, outside);

    await writeFile(path.join(outside, 'secret.txt'), 'top secret');
    await symlink(outside, path.join(root, 'linked-outside'));

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/linked-outside/');
    expect(response.status).toBe(403);
  });

  test('rejects malformed percent-encoded paths', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/%E0%A4%A');
    expect(response.status).toBe(400);
  });

  test('rejects traversal-style paths', async () => {
    const root = await makeTempDir();
    const outside = await makeTempDir();
    cleanupDirs.push(root, outside);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');
    await writeFile(path.join(outside, 'outside.txt'), 'top secret');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/%2e%2e/hello.txt');
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('top secret');
  });

  test('redirects directory requests to a trailing slash', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/nested');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toContain('/assets/nested/');
  });

  test('serves index files before directory listings', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'index.html'), '<h1>Nested Index</h1>');
    await writeFile(path.join(root, 'nested', 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/nested/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toContain('Nested Index');
  });

  test('hides dotfiles by default and can include them explicitly', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, '.secret'), 'hidden');
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const defaultApp = new Hono();
    defaultApp.use('/assets/*', mountServeIndex(root));
    const defaultResponse = await defaultApp.request('http://example.test/assets/', { headers: { Accept: 'text/plain' } });
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.text()).toBe('hello.txt\n');

    const directHiddenResponse = await defaultApp.request('http://example.test/assets/.secret');
    expect(directHiddenResponse.status).toBe(404);

    const hiddenApp = new Hono();
    hiddenApp.use('/assets/*', mountServeIndex(root, { hidden: true }));
    const hiddenResponse = await hiddenApp.request('http://example.test/assets/', { headers: { Accept: 'text/plain' } });
    expect(hiddenResponse.status).toBe(200);
    expect(await hiddenResponse.text()).toContain('.secret');

    const directVisibleResponse = await hiddenApp.request('http://example.test/assets/.secret');
    expect(directVisibleResponse.status).toBe(200);
    expect(await directVisibleResponse.text()).toBe('hidden');
  });

  test('blocks symlink aliases to hidden targets by default and allows them with hidden enabled', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, '.private'), { recursive: true });
    await writeFile(path.join(root, '.secret'), 'hidden');
    await writeFile(path.join(root, '.private', 'nested.txt'), 'nested secret');
    await symlink(path.join(root, '.secret'), path.join(root, 'alias.txt'));
    await symlink(path.join(root, '.private'), path.join(root, 'public-dir'));

    const defaultApp = new Hono();
    defaultApp.use('/assets/*', mountServeIndex(root));

    const hiddenAliasResponse = await defaultApp.request('http://example.test/assets/alias.txt');
    expect(hiddenAliasResponse.status).toBe(404);

    const hiddenDirectoryResponse = await defaultApp.request('http://example.test/assets/public-dir/');
    expect(hiddenDirectoryResponse.status).toBe(404);

    const listingResponse = await defaultApp.request('http://example.test/assets/', { headers: { Accept: 'text/plain' } });
    expect(listingResponse.status).toBe(200);
    expect(await listingResponse.text()).toBe('\n');

    const hiddenApp = new Hono();
    hiddenApp.use('/assets/*', mountServeIndex(root, { hidden: true }));

    const visibleAliasResponse = await hiddenApp.request('http://example.test/assets/alias.txt');
    expect(visibleAliasResponse.status).toBe(200);
    expect(await visibleAliasResponse.text()).toBe('hidden');

    const visibleListingResponse = await hiddenApp.request('http://example.test/assets/', { headers: { Accept: 'text/plain' } });
    expect(visibleListingResponse.status).toBe(200);
    expect(await visibleListingResponse.text()).toContain('alias.txt');

    const visibleDirectoryResponse = await hiddenApp.request('http://example.test/assets/public-dir/nested.txt');
    expect(visibleDirectoryResponse.status).toBe(200);
    expect(await visibleDirectoryResponse.text()).toBe('nested secret');
  });

  test('ignores hidden symlinked index files by default and serves them when hidden is enabled', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'public'), { recursive: true });
    await writeFile(path.join(root, '.secret.html'), '<h1>secret index</h1>');
    await writeFile(path.join(root, 'public', 'hello.txt'), 'hello world');
    await symlink(path.join(root, '.secret.html'), path.join(root, 'public', 'index.html'));

    const defaultApp = new Hono();
    defaultApp.use('/assets/*', mountServeIndex(root));

    const defaultResponse = await defaultApp.request('http://example.test/assets/public/', { headers: { Accept: 'text/html' } });
    expect(defaultResponse.status).toBe(200);
    const defaultBody = await defaultResponse.text();
    expect(defaultBody).toContain('hello.txt');
    expect(defaultBody).not.toContain('secret index');

    const hiddenApp = new Hono();
    hiddenApp.use('/assets/*', mountServeIndex(root, { hidden: true }));

    const hiddenResponse = await hiddenApp.request('http://example.test/assets/public/', { headers: { Accept: 'text/html' } });
    expect(hiddenResponse.status).toBe(200);
    expect(await hiddenResponse.text()).toContain('secret index');
  });

  test('supports subfolder rewrites', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'hello.txt'), 'hello from nested');

    const app = new Hono().basePath('/app');
    app.use('/assets/*', serveIndex(root, { rewriteRequestPath: (pathname) => pathname.replace(/^\/app\/assets/, '') || '/' }));

    const response = await app.request('http://example.test/app/assets/nested/hello.txt');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello from nested');
  });

  test('renders parent directory links for express and nginx listings', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'hello.txt'), 'hello world');

    const expressApp = new Hono();
    expressApp.use('/assets/*', mountServeIndex(root));
    const expressResponse = await expressApp.request('http://example.test/assets/nested/', { headers: { Accept: 'text/html' } });
    const expressBody = await expressResponse.text();

    expect(expressResponse.status).toBe(200);
    expect(expressBody).toContain('title=".."');
    expect(expressBody).toContain('href="/assets"');

    const nginxApp = new Hono();
    nginxApp.use('/assets/*', mountServeIndex(root, { preset: 'nginx' }));
    const nginxResponse = await nginxApp.request('http://example.test/assets/nested/', { headers: { Accept: 'text/html' } });

    expect(nginxResponse.status).toBe(200);
    expect(await nginxResponse.text()).toContain('<a href="../">../</a>');
  });

  test('matches express serve-index html formatting', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'alpha.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/', { headers: { Accept: 'text/html' } });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain('<!DOCTYPE html>');
    expect(body).toContain('maximum-scale=1.0, user-scalable=no');
    expect(body).not.toContain('nonce=');
    expect(body).toContain('<h1><a href="/">~</a> / <a href="/assets">assets</a> / </h1>');
    expect(body).toContain('<a href="/assets/nested" class="" title="nested">');
  });

  test('loads the nginx preset without missing assets', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'hello.txt'), 'hello world');

    const app = new Hono();
    app.use('/assets/*', serveIndex(root, { preset: 'nginx', rewriteRequestPath: (pathname) => pathname.replace(/^\/assets/, '') || '/' }));

    const response = await app.request('http://example.test/assets/', { headers: { Accept: 'text/html' } });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Index of /assets/');
  });

  test('matches nginx autoindex html formatting', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);

    const nestedPath = path.join(root, 'nested');
    const longName = '012345678901234567890123456789012345678901234567890123456789.txt';
    const specialName = 'A space & symbols <here>.txt';
    const fixedDate = new Date(Date.UTC(2024, 0, 2, 3, 4, 5));

    await mkdir(nestedPath, { recursive: true });
    await writeFile(path.join(root, longName), 'x');
    await writeFile(path.join(root, specialName), 'x');
    await writeFile(path.join(root, 'alpha.txt'), 'x');
    await utimes(nestedPath, fixedDate, fixedDate);
    await utimes(path.join(root, longName), fixedDate, fixedDate);
    await utimes(path.join(root, specialName), fixedDate, fixedDate);
    await utimes(path.join(root, 'alpha.txt'), fixedDate, fixedDate);

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root, { preset: 'nginx' }));

    const response = await app.request('http://example.test/assets/', { headers: { Accept: 'text/html' } });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(
      [
        '<html>',
        '<head><title>Index of /assets/</title></head>',
        '<body>',
        '<h1>Index of /assets/</h1><hr><pre><a href="../">../</a>',
        '<a href="nested/">nested/</a>                                            02-Jan-2024 03:04                   -',
        `<a href="${encodeURIComponent(longName)}">01234567890123456789012345678901234567890123456..&gt;</a> 02-Jan-2024 03:04                   1`,
        `<a href="${encodeURIComponent(specialName)}">A space &amp; symbols &lt;here&gt;.txt</a>                       02-Jan-2024 03:04                   1`,
        '<a href="alpha.txt">alpha.txt</a>                                          02-Jan-2024 03:04                   1',
        '</pre><hr></body>',
        '</html>',
        '',
      ].join('\r\n'),
    );
  });

  test('rejects special files instead of streaming them', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);

    const fifoPath = path.join(root, 'named-pipe');
    const fifoResult = spawnSync('mkfifo', [fifoPath]);
    expect(fifoResult.status).toBe(0);

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/named-pipe');
    expect(response.status).toBe(403);
  });

  test('returns 304 for index files with matching ETag', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'index.html'), '0123456789');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const initial = await app.request('http://example.test/assets/nested/');
    expect(initial.status).toBe(200);
    expect(await initial.text()).toBe('0123456789');

    const etag = requireHeader(initial.headers.get('etag'), 'etag');

    const response = await app.request('http://example.test/assets/nested/', { headers: { 'If-None-Match': etag } });
    expect(response.status).toBe(304);
  });

  test('serves byte ranges for index files with If-Range date', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'index.html'), '0123456789');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const initial = await app.request('http://example.test/assets/nested/');
    const lastModified = requireHeader(initial.headers.get('last-modified'), 'last-modified');
    await initial.text();

    const response = await app.request('http://example.test/assets/nested/', { headers: { 'If-Range': lastModified, Range: 'bytes=2-5' } });
    expect(response.status).toBe(206);
    expect(await response.text()).toBe('2345');
  });

  test('ignores multi-range requests and returns full content', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'index.html'), '0123456789');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/nested/', { headers: { Range: 'bytes=0-1,3-4' } });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
  });

  test('returns 416 for zero-length suffix range', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'index.html'), '0123456789');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root));

    const response = await app.request('http://example.test/assets/nested/', { headers: { Range: 'bytes=-0' } });
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
  });

  test('renders the apache preset with sortable column headers', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'alpha.txt'), 'aaa');
    await writeFile(path.join(root, 'nested', 'beta.txt'), 'bb');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root, { preset: 'apache' }));

    const response = await app.request('http://example.test/assets/nested/', { headers: { Accept: 'text/html' } });
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('alpha.txt');
    expect(body).toContain('beta.txt');
    expect(body).toContain('Parent Directory');
    expect(body).toContain('?C=N;O=');
    expect(body).toContain('?C=M;O=');
    expect(body).toContain('?C=S;O=');
    expect(body).toContain('<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN"');
    expect(body).toContain('<table>');
    expect(body).not.toContain('<address>');
  });

  test('serves apache preset icon assets from listing markup', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'alpha.txt'), 'aaa');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root, { preset: 'apache' }));

    const listingResponse = await app.request('http://example.test/assets/nested/', { headers: { Accept: 'text/html' } });
    expect(listingResponse.status).toBe(200);

    const body = await listingResponse.text();
    const iconUrl = requireHeader(/src="([^"]*\/assets\/icons\/[^"]+)"/.exec(body)?.[1], 'apache icon url');
    const assetResponse = await app.request(`http://example.test${iconUrl}`);
    const assetBytes = await assetResponse.arrayBuffer();

    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toBe('image/gif');
    expect(requireHeader(assetResponse.headers.get('etag'), 'apache icon etag')).toMatch(/^W\//);
    expect(assetBytes.byteLength).toBeGreaterThan(0);
  });

  test('template functions can link preset-local assets', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'alpha.txt'), 'aaa');

    const app = new Hono();
    app.use(
      '/assets/*',
      mountServeIndex(root, {
        preset: 'apache',
        template: (locals) => `<img src="${locals.templateAssetUrl('icons/blank.gif')}" alt="template asset" />`,
      }),
    );

    const listingResponse = await app.request('http://example.test/assets/', { headers: { Accept: 'text/html' } });
    expect(listingResponse.status).toBe(200);

    const body = await listingResponse.text();
    const iconUrl = requireHeader(/src="([^"]*\/assets\/icons\/[^"]+)"/.exec(body)?.[1], 'template asset url');
    const assetResponse = await app.request(`http://example.test${iconUrl}`);

    expect(assetResponse.status).toBe(200);
    expect(assetResponse.headers.get('content-type')).toBe('image/gif');
  });

  test('apache preset matches Apache index ignore behavior and PDF icon mapping', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'README'), 'read me');
    await writeFile(path.join(root, 'manual.pdf'), 'pdf-ish');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root, { preset: 'apache' }));

    const response = await app.request('http://example.test/assets/', { headers: { Accept: 'text/html' } });
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).not.toContain('README');
    expect(body).toContain('/assets/icons/layout.gif');
    expect(body).toContain('alt="[   ]"');
  });

  test('apache preset emits Apache-style alt text for parent, directory, and type icons', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await mkdir(path.join(root, 'nested', 'child'), { recursive: true });
    await writeFile(path.join(root, 'nested', 'photo.png'), 'png-ish');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root, { preset: 'apache' }));

    const response = await app.request('http://example.test/assets/nested/', { headers: { Accept: 'text/html' } });
    expect(response.status).toBe(200);

    const body = await response.text();
    expect(body).toContain('/assets/icons/back.gif');
    expect(body).toContain('alt="[PARENTDIR]"');
    expect(body).toContain('/assets/icons/folder.gif');
    expect(body).toContain('alt="[DIR]"');
    expect(body).toContain('/assets/icons/image2.gif');
    expect(body).toContain('alt="[IMG]"');
    expect(body).toContain('alt="[ICO]"');
    expect(body).toContain('href="/assets/nested/../"');
  });

  test('apache preset sort links round-trip with standard query separators', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'small.txt'), 'a');
    await writeFile(path.join(root, 'large.txt'), 'a'.repeat(10_000));

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root, { preset: 'apache' }));

    const initial = await app.request('http://example.test/assets/', { headers: { Accept: 'text/html' } });
    expect(initial.status).toBe(200);

    const initialBody = await initial.text();
    const sizeSortLink = requireHeader(/href="(\?C=S;O=[AD])"/.exec(initialBody)?.[1], 'apache size sort link');

    const response = await app.request(`http://example.test/assets/${sizeSortLink}`, { headers: { Accept: 'text/html' } });
    expect(response.status).toBe(200);

    const body = await response.text();
    const smallIndex = body.indexOf('small.txt');
    const largeIndex = body.indexOf('large.txt');
    expect(smallIndex).toBeLessThan(largeIndex);
  });

  test('apache preset sorts by size descending', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'small.txt'), 'a');
    await writeFile(path.join(root, 'large.txt'), 'a'.repeat(10_000));

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root, { preset: 'apache' }));

    const response = await app.request('http://example.test/assets/?C=S&O=D', { headers: { Accept: 'text/html' } });
    expect(response.status).toBe(200);

    const body = await response.text();
    const largeIndex = body.indexOf('large.txt');
    const smallIndex = body.indexOf('small.txt');
    expect(largeIndex).toBeLessThan(smallIndex);
  });

  test('apache preset still accepts legacy semicolon sort queries', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'small.txt'), 'a');
    await writeFile(path.join(root, 'large.txt'), 'a'.repeat(10_000));

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root, { preset: 'apache' }));

    const response = await app.request('http://example.test/assets/?C=S;O=D', { headers: { Accept: 'text/html' } });
    expect(response.status).toBe(200);

    const body = await response.text();
    const largeIndex = body.indexOf('large.txt');
    const smallIndex = body.indexOf('small.txt');
    expect(largeIndex).toBeLessThan(smallIndex);
  });

  test('concurrent apache requests with different sort params do not interfere', async () => {
    const root = await makeTempDir();
    cleanupDirs.push(root);
    await writeFile(path.join(root, 'alpha.txt'), 'aaa');
    await writeFile(path.join(root, 'zulu.txt'), 'z');

    const app = new Hono();
    app.use('/assets/*', mountServeIndex(root, { preset: 'apache' }));

    const [ascResponse, descResponse] = await Promise.all([
      app.request('http://example.test/assets/?C=N&O=A', { headers: { Accept: 'text/html' } }),
      app.request('http://example.test/assets/?C=N&O=D', { headers: { Accept: 'text/html' } }),
    ]);

    const ascBody = await ascResponse.text();
    const descBody = await descResponse.text();

    const ascAlpha = ascBody.indexOf('>alpha.txt<');
    const ascZulu = ascBody.indexOf('>zulu.txt<');
    expect(ascAlpha).toBeLessThan(ascZulu);

    const descAlpha = descBody.indexOf('>alpha.txt<');
    const descZulu = descBody.indexOf('>zulu.txt<');
    expect(descAlpha).toBeGreaterThan(descZulu);
  });
});
