import type { Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';

import type { Context } from 'hono';
import { contentType } from 'mime-types';

interface ByteRange {
  start: number;
  end: number;
}

interface FileEntity {
  etag: string;
  filePath: string;
  mtimeMs: number;
  size: number;
}

interface CacheValidationHeaders {
  ifModifiedSince?: string;
  ifNoneMatch?: string;
}

const unsatisfiableRange = 'unsatisfiable' as const;

const getEntityTag = (stats: Stats) => `W/"${stats.size.toString(16)}-${Math.trunc(stats.mtimeMs).toString(16)}"`;

const safeMimeTypes = new Set(['application/json', 'application/pdf', 'audio/', 'image/', 'text/css', 'text/plain', 'video/']);

const normalizeEntityTag = (tag: string) => tag.replace(/^W\//, '');

const hasFreshEntityTag = (ifNoneMatch: string, etag: string) => {
  const normalizedEtag = normalizeEntityTag(etag);
  return ifNoneMatch
    .split(',')
    .map((part) => part.trim())
    .some((part) => part === '*' || normalizeEntityTag(part) === normalizedEtag);
};

const parseHttpDate = (value?: string) => {
  if (!value) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
};

const isNotModified = ({ ifModifiedSince, ifNoneMatch }: CacheValidationHeaders, entity: Pick<FileEntity, 'etag' | 'mtimeMs'>) => {
  if (ifNoneMatch) {
    return hasFreshEntityTag(ifNoneMatch, entity.etag);
  }

  const modifiedSince = parseHttpDate(ifModifiedSince);
  return modifiedSince !== undefined && Math.trunc(entity.mtimeMs / 1000) * 1000 <= modifiedSince;
};

const shouldProcessRange = (ifRange: string | undefined, etag: string, mtimeMs: number) => {
  if (!ifRange) {
    return true;
  }

  if (ifRange.includes('"')) {
    return normalizeEntityTag(ifRange.trim()) === normalizeEntityTag(etag);
  }

  const ifRangeDate = parseHttpDate(ifRange);
  return ifRangeDate !== undefined && Math.trunc(mtimeMs / 1000) * 1000 <= ifRangeDate;
};

const parseByteRange = (rangeHeader: string, size: number): ByteRange | typeof unsatisfiableRange | undefined => {
  if (!rangeHeader.startsWith('bytes=')) {
    return undefined;
  }

  const rangeValue = rangeHeader.slice('bytes='.length).trim();
  if (!rangeValue || rangeValue.includes(',')) {
    return undefined;
  }

  const match = /^(\d*)-(\d*)$/.exec(rangeValue);
  if (!match) {
    return undefined;
  }

  const [, startPart, endPart] = match;
  if (size === 0 || (!startPart && !endPart)) {
    return unsatisfiableRange;
  }

  if (!startPart) {
    const suffixLength = Number(endPart);
    if (!Number.isInteger(suffixLength) || suffixLength <= 0) {
      return unsatisfiableRange;
    }

    return { end: size - 1, start: Math.max(size - suffixLength, 0) };
  }

  const start = Number(startPart);
  if (!Number.isInteger(start) || start < 0 || start >= size) {
    return unsatisfiableRange;
  }

  const parsedEnd = endPart ? Number(endPart) : size - 1;
  if (!Number.isInteger(parsedEnd) || parsedEnd < start) {
    return unsatisfiableRange;
  }

  return { end: Math.min(parsedEnd, size - 1), start };
};

const isSafeMimeType = (mime: string): boolean => {
  for (const safe of safeMimeTypes) {
    if (safe.endsWith('/') ? mime.startsWith(safe) : mime === safe) {
      return true;
    }
  }
  return false;
};

const buildFileHeaders = (entity: FileEntity, contentLength?: number) => {
  const headers = new Headers();
  const mime = contentType(path.basename(entity.filePath)) || 'application/octet-stream';
  headers.set('Accept-Ranges', 'bytes');
  if (contentLength !== undefined) {
    headers.set('Content-Length', contentLength.toString());
  }
  headers.set('Content-Type', mime);
  headers.set('ETag', entity.etag);
  headers.set('Last-Modified', new Date(entity.mtimeMs).toUTCString());
  headers.set('X-Content-Type-Options', 'nosniff');

  if (!isSafeMimeType(mime.split(';')[0]?.trim() ?? mime)) {
    headers.set('Content-Disposition', 'attachment');
  }

  return headers;
};

const STREAM_CHUNK_SIZE = 65_536;

const streamFile = (filePath: string, range?: ByteRange): ReadableStream<Uint8Array> => {
  const start = range?.start ?? 0;
  const end = range?.end;
  let position = start;
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined = undefined;

  const closeFileHandle = async () => {
    if (!fileHandle) {
      return;
    }

    const handle = fileHandle;
    fileHandle = undefined;
    await handle.close();
  };

  const getFileHandle = () => {
    if (!fileHandle) {
      throw new Error('File handle not initialized');
    }

    return fileHandle;
  };

  return new ReadableStream({
    async cancel() {
      await closeFileHandle();
    },
    async pull(controller) {
      const remaining = end !== undefined ? end - position + 1 : STREAM_CHUNK_SIZE;
      const buf = new Uint8Array(Math.min(STREAM_CHUNK_SIZE, remaining));
      const handle = getFileHandle();
      const { bytesRead } = await handle.read(buf, 0, buf.length, position);

      if (bytesRead === 0) {
        controller.close();
        await closeFileHandle();
        return;
      }

      position += bytesRead;
      controller.enqueue(bytesRead < buf.length ? buf.subarray(0, bytesRead) : buf);

      if (end !== undefined && position > end) {
        controller.close();
        await closeFileHandle();
      }
    },
    async start() {
      fileHandle = await open(filePath, 'r');
    },
  });
};

const createFileEntity = (filePath: string, stats: Stats): FileEntity => ({
  etag: getEntityTag(stats),
  filePath,
  mtimeMs: stats.mtimeMs,
  size: stats.size,
});

const createFileResponse = ({ entity, method, range }: { entity: FileEntity; method: string; range?: ByteRange }) => {
  const contentLength = range ? range.end - range.start + 1 : entity.size;
  const headers = buildFileHeaders(entity, contentLength);
  const status = range ? 206 : 200;

  if (range) {
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${entity.size}`);
  }

  if (method === 'HEAD') {
    return new Response(undefined, { headers, status });
  }

  return new Response(streamFile(entity.filePath, range), { headers, status });
};

export const handleFileResponse = (c: Context, filePath: string, stats: Stats): Response => {
  const entity = createFileEntity(filePath, stats);
  const cacheValidationHeaders: CacheValidationHeaders = { ifModifiedSince: c.req.header('if-modified-since'), ifNoneMatch: c.req.header('if-none-match') };

  if (isNotModified(cacheValidationHeaders, entity)) {
    return new Response(undefined, { headers: buildFileHeaders(entity), status: 304 });
  }

  const rangeHeader = c.req.header('range');

  if (rangeHeader && shouldProcessRange(c.req.header('if-range'), entity.etag, entity.mtimeMs)) {
    const range = parseByteRange(rangeHeader, entity.size);

    if (range === unsatisfiableRange) {
      const headers = buildFileHeaders(entity);
      headers.set('Content-Range', `bytes */${entity.size}`);
      return new Response(undefined, { headers, status: 416 });
    }

    if (range) {
      return createFileResponse({ entity, method: c.req.method, range });
    }
  }

  return createFileResponse({ entity, method: c.req.method });
};
