import type { Dirent, Stats } from 'node:fs';
import { stat as fsStat, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Context } from 'hono';
import { accepts } from 'hono/accepts';

import { handleFileResponse } from './file-response.js';
import { hasHiddenResolvedPath, resolveContainedPath } from './path-security.js';
import { generateNonce } from './template.js';
import { defaultViewName, isValidViewName } from './types.js';
import type { File, Locals, RenderContext, ResolvedTemplate, ServeIndexFilter, ServeIndexOptions } from './types.js';
import { getErrorCode } from './utils.js';

const directoryIndexFiles = ['index.html', 'index.htm'] as const;

const STAT_CONCURRENCY = 64;

const mediaTypes = ['text/html', 'text/plain', 'application/json'] as const;
type MediaType = (typeof mediaTypes)[number];

interface DirectoryInspectionOptions {
  allowHidden: boolean;
  directoryPath: string;
  includeStats: boolean;
  rootRealPath: string;
}

interface ListedDirectoryEntry {
  isDirectory: boolean;
  name: string;
  stat: File['stat'];
}

const defaultSort = (a: { name: string; isDirectory: boolean }, b: { name: string; isDirectory: boolean }) => {
  if (a.name === '..' || b.name === '..') {
    if (a.name === b.name) {
      return 0;
    }

    return a.name === '..' ? -1 : 1;
  }

  return Number(b.isDirectory) - Number(a.isDirectory) || a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase());
};

const fileSort = (a: File, b: File) =>
  defaultSort({ isDirectory: Boolean(a.stat?.isDirectory()), name: a.name }, { isDirectory: Boolean(b.stat?.isDirectory()), name: b.name });

const inspectDirectoryEntry = async (dirent: Dirent, options: DirectoryInspectionOptions): Promise<ListedDirectoryEntry | undefined> => {
  const { allowHidden, directoryPath, includeStats, rootRealPath } = options;
  const { name } = dirent;
  const entryPath = path.join(directoryPath, name);

  try {
    if (dirent.isSymbolicLink()) {
      const resolvedChildPath = await resolveContainedPath(rootRealPath, entryPath);

      if (!allowHidden && hasHiddenResolvedPath(rootRealPath, resolvedChildPath)) {
        return undefined;
      }

      if (!includeStats) {
        const stat = await fsStat(resolvedChildPath);
        return { isDirectory: stat.isDirectory(), name, stat: undefined };
      }

      const stat = await fsStat(resolvedChildPath);
      return { isDirectory: stat.isDirectory(), name, stat };
    }

    if (!includeStats) {
      return { isDirectory: dirent.isDirectory(), name, stat: undefined };
    }

    const stat = await fsStat(entryPath);
    return { isDirectory: stat.isDirectory(), name, stat };
  } catch (error) {
    const code = getErrorCode(error);

    if (code !== 'ENOENT' && code !== 'EACCES') {
      throw error;
    }

    return { isDirectory: dirent.isDirectory(), name, stat: undefined };
  }
};

const inspectDirectoryEntries = async (entries: Dirent[], options: DirectoryInspectionOptions) => {
  const results: (ListedDirectoryEntry | undefined)[] = Array.from({ length: entries.length });
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < entries.length) {
      const i = nextIndex;
      nextIndex += 1;
      const entry = entries[i];
      if (entry) {
        results[i] = await inspectDirectoryEntry(entry, options);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(STAT_CONCURRENCY, entries.length) }, worker));

  const filtered: ListedDirectoryEntry[] = [];
  for (const entry of results) {
    if (entry !== undefined) {
      filtered.push(entry);
    }
  }
  return filtered;
};

const createDirectoryListingHeadResponse = (type: MediaType) =>
  new Response(undefined, {
    headers: {
      'Cache-Control': 'no-cache',
      'Content-Type': `${type}; charset=UTF-8`,
      Vary: 'Accept',
      'X-Content-Type-Options': 'nosniff',
    },
    status: 200,
  });

interface DirectoryInspection {
  allowHidden: boolean;
  directoryPath: string;
  entries: Dirent[];
  rootRealPath: string;
}

interface HtmlResponseOptions extends DirectoryInspection {
  directory: string;
  host: string;
  showUp: boolean;
  resolvedPreset: ResolvedTemplate;
  renderContext: RenderContext;
}

const handleHtmlResponse = async ({
  allowHidden,
  entries,
  directory,
  host,
  showUp,
  directoryPath,
  rootRealPath,
  resolvedPreset,
  renderContext,
}: HtmlResponseOptions) => {
  const inspectionOptions: DirectoryInspectionOptions = { allowHidden, directoryPath, includeStats: true, rootRealPath };
  const statted = await inspectDirectoryEntries(entries, inspectionOptions);
  const files = statted.map(({ name, stat }) => ({ name, stat }));

  if (showUp) {
    files.unshift({ name: '..', stat: undefined });
  }

  const sorted = resolvedPreset.sortFiles ? resolvedPreset.sortFiles(files, renderContext.queryString) : files.toSorted(fileSort);
  const nonce = generateNonce();
  const locals: Locals = {
    directory,
    fileList: sorted,
    host,
    nonce,
    path: directoryPath,
    renderContext,
    style: resolvedPreset.stylesheetContent,
  };

  return resolvedPreset.render(sorted, directory, locals);
};

interface DataResponseOptions extends DirectoryInspection {
  c: Context;
}

const handleJsonResponse = async ({ allowHidden, c, entries, directoryPath, rootRealPath }: DataResponseOptions) => {
  const inspectionOptions: DirectoryInspectionOptions = { allowHidden, directoryPath, includeStats: false, rootRealPath };
  const listedEntries = await inspectDirectoryEntries(entries, inspectionOptions);
  return c.json(listedEntries.toSorted(defaultSort).map((entry) => entry.name));
};

const handlePlainResponse = async ({ allowHidden, c, entries, directoryPath, rootRealPath }: DataResponseOptions) => {
  const inspectionOptions: DirectoryInspectionOptions = { allowHidden, directoryPath, includeStats: false, rootRealPath };
  const listedEntries = await inspectDirectoryEntries(entries, inspectionOptions);
  return c.text(
    `${listedEntries
      .toSorted(defaultSort)
      .map((entry) => entry.name)
      .join('\n')}\n`,
  );
};

const isMediaType = (value: string): value is MediaType => value === 'text/html' || value === 'text/plain' || value === 'application/json';

const getAcceptedDirectoryType = (c: Context): MediaType => {
  const accepted = accepts(c, { default: 'text/html', header: 'Accept', supports: [...mediaTypes] });
  return isMediaType(accepted) ? accepted : 'text/html';
};

interface DirectoryFilterOptions {
  entries: Dirent[];
  filterFn?: ServeIndexFilter;
  hidden: boolean;
  resolvedPath: string;
}

const filterDirectoryEntries = ({ entries, filterFn, hidden, resolvedPath }: DirectoryFilterOptions) => {
  const visibleEntries = hidden ? entries : entries.filter((dirent) => !dirent.name.startsWith('.'));

  if (!filterFn) {
    return visibleEntries;
  }

  const fileNames = visibleEntries.map((dirent) => dirent.name);
  return visibleEntries.filter((dirent, index) => filterFn(dirent.name, index, fileNames, resolvedPath));
};

const normalizeQueryString = (queryString: string): string => queryString.replaceAll(';', '&');

const createRenderContext = (options: ServeIndexOptions, url: URL): RenderContext => {
  const queryString = url.search.startsWith('?') ? url.search.slice(1) : url.search;
  const searchParams = new URLSearchParams(normalizeQueryString(queryString));
  const rawView = searchParams.get('view') ?? options.view ?? defaultViewName;
  return {
    queryString,
    viewName: isValidViewName(rawView) ? rawView : defaultViewName,
  };
};

interface DirectoryRenderOptions {
  c: Context;
  directory: string;
  filterFn?: ServeIndexFilter;
  serveIndexOptions: ServeIndexOptions;
  resolvedPath: string;
  resolvedPreset: ResolvedTemplate;
  rootRealPath: string;
  url: URL;
}

interface DirectoryIndexResult {
  path: string;
  stats: Stats;
}

const findDirectoryIndex = async (rootRealPath: string, directoryPath: string, allowHidden: boolean): Promise<DirectoryIndexResult | undefined> => {
  for (const indexFile of directoryIndexFiles) {
    const candidatePath = path.join(directoryPath, indexFile);

    try {
      const resolvedPath = await resolveContainedPath(rootRealPath, candidatePath);

      if (allowHidden || !hasHiddenResolvedPath(rootRealPath, resolvedPath)) {
        const stats: Stats = await fsStat(resolvedPath);

        if (stats.isFile()) {
          return { path: resolvedPath, stats };
        }
      }
    } catch (error) {
      const code = getErrorCode(error);

      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') {
        throw error;
      }
    }
  }

  return undefined;
};

const handleDirectoryRender = async ({
  c,
  directory,
  filterFn,
  serveIndexOptions,
  resolvedPath,
  resolvedPreset,
  rootRealPath,
  url,
}: DirectoryRenderOptions): Promise<Response> => {
  if (!url.pathname.endsWith('/')) {
    const target = new URL(`${url.pathname}/`, url.origin);
    target.search = url.search;
    return c.redirect(target.href, 301);
  }

  const directoryIndex = await findDirectoryIndex(rootRealPath, resolvedPath, Boolean(serveIndexOptions.hidden));

  if (directoryIndex) {
    return handleFileResponse(c, directoryIndex.path, directoryIndex.stats);
  }

  const acceptedType = getAcceptedDirectoryType(c);
  if (c.req.method === 'HEAD') {
    return createDirectoryListingHeadResponse(acceptedType);
  }

  const entries = filterDirectoryEntries({
    entries: await readdir(resolvedPath, { withFileTypes: true }),
    filterFn,
    hidden: Boolean(serveIndexOptions.hidden),
    resolvedPath,
  });

  const allowHidden = Boolean(serveIndexOptions.hidden);
  const inspection: DirectoryInspection = { allowHidden, directoryPath: resolvedPath, entries, rootRealPath };

  if (acceptedType === 'text/html') {
    return handleHtmlResponse({
      ...inspection,
      directory,
      host: url.host,
      renderContext: createRenderContext(serveIndexOptions, url),
      resolvedPreset,
      showUp: resolvedPath !== rootRealPath,
    });
  }

  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Cache-Control', 'no-cache');
  c.header('Vary', 'Accept');

  if (acceptedType === 'application/json') {
    return handleJsonResponse({ ...inspection, c });
  }

  return handlePlainResponse({ ...inspection, c });
};

export { handleDirectoryRender };
export type { DirectoryRenderOptions };
