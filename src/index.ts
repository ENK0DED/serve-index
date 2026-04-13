import { realpath, stat as fsStat } from 'node:fs/promises';
import path from 'node:path';

import { createMiddleware } from 'hono/factory';
import { HTTPException } from 'hono/http-exception';

import type { DirectoryRenderOptions } from './directory-listing.js';
import { handleDirectoryRender } from './directory-listing.js';
import { handleFileResponse } from './file-response.js';
import { PathEscapeError, hasHiddenPathSegment, hasHiddenResolvedPath, isContainedPath, resolveContainedPath } from './path-security.js';
import { resolvePreset } from './template.js';
import type { ServeIndexOptions, ServeIndexPreset } from './types.js';
import { getErrorCode } from './utils.js';

const defaultPreset: ServeIndexPreset = 'express';

const decodePathname = (pathname: string): string | undefined => {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return undefined;
  }
};

const validateRequestedPath = (directory: string, hidden: boolean, rootRealPath: string) => {
  const requestedPath = path.normalize(path.join(rootRealPath, directory));

  if (requestedPath.includes('\0')) {
    throw new HTTPException(400);
  }

  if (!hidden && hasHiddenPathSegment(directory)) {
    throw new HTTPException(404);
  }

  if (!isContainedPath(rootRealPath, requestedPath)) {
    throw new HTTPException(403);
  }

  return requestedPath;
};

const handleOptionsRequest = () =>
  new Response(undefined, {
    headers: { Allow: 'GET, HEAD, OPTIONS' },
    status: 200,
  });

const handleResolvedRequest = async (renderOptions: DirectoryRenderOptions): Promise<Response> => {
  const { c, resolvedPath, rootRealPath, serveIndexOptions } = renderOptions;

  if (!serveIndexOptions.hidden && hasHiddenResolvedPath(rootRealPath, resolvedPath)) {
    throw new HTTPException(404);
  }

  const resolvedStat = await fsStat(resolvedPath);
  if (!resolvedStat.isDirectory()) {
    if (!resolvedStat.isFile()) {
      throw new HTTPException(403);
    }

    return handleFileResponse(c, resolvedPath, resolvedStat);
  }

  return handleDirectoryRender(renderOptions);
};

const handleMiddlewareError = async (error: unknown, next: () => Promise<void>) => {
  if (error instanceof HTTPException) {
    throw error;
  }

  if (error instanceof PathEscapeError) {
    throw new HTTPException(403);
  }

  const errorCode = getErrorCode(error);
  if (errorCode === 'ENOENT') {
    return next();
  }

  if (errorCode === 'EACCES') {
    throw new HTTPException(403);
  }

  throw new HTTPException(errorCode === 'ENAMETOOLONG' ? 414 : 500);
};

export type * from './types.js';
export { compileTemplate, isTemplatePartName, templatePlaceholderPattern } from './template.js';

export const serveIndex = (root: string, options: ServeIndexOptions = {}): ReturnType<typeof createMiddleware> => {
  if (!root) {
    throw new TypeError('serveIndex() root path required');
  }

  const { filter: filterFn, rewriteRequestPath } = options;
  const preset = options.preset ?? defaultPreset;
  const resolvedRootPromise = realpath(path.resolve(root));
  const resolvedPresetPromise = resolvePreset(preset, options);

  return createMiddleware(async (c, next) => {
    const { method } = c.req;
    if (method === 'OPTIONS') {
      return handleOptionsRequest();
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return next();
    }

    const [rootRealPath, resolvedPreset] = await Promise.all([resolvedRootPromise, resolvedPresetPromise]);

    const url = new URL(c.req.url);
    const displayDirectory = decodePathname(url.pathname);
    if (displayDirectory === undefined) {
      throw new HTTPException(400);
    }

    const directory = rewriteRequestPath ? (rewriteRequestPath(displayDirectory) ?? displayDirectory) : displayDirectory;
    const requestedPath = validateRequestedPath(directory, Boolean(options.hidden), rootRealPath);

    try {
      const resolvedPath = await resolveContainedPath(rootRealPath, requestedPath);
      return handleResolvedRequest({ c, directory: displayDirectory, filterFn, resolvedPath, resolvedPreset, rootRealPath, serveIndexOptions: options, url });
    } catch (error) {
      return handleMiddlewareError(error, next);
    }
  });
};
