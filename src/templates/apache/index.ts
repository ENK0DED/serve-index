import path from 'node:path';

import { formatFileDate } from '../../template-helpers.js';
import type { File, RenderContext } from '../../types.js';
import { escapeHtml } from '../../utils.js';

const iconByExt: Record<string, string> = {
  '.avi': '[VID]',
  '.bin': '[BIN]',
  '.bz2': '[ARC]',
  '.csv': '[TXT]',
  '.exe': '[BIN]',
  '.gif': '[IMG]',
  '.gz': '[ARC]',
  '.htm': '[HTM]',
  '.html': '[HTM]',
  '.jpeg': '[IMG]',
  '.jpg': '[IMG]',
  '.json': '[CFG]',
  '.md': '[TXT]',
  '.mkv': '[VID]',
  '.mp3': '[AUD]',
  '.mp4': '[VID]',
  '.ogg': '[AUD]',
  '.pdf': '[PDF]',
  '.png': '[IMG]',
  '.svg': '[IMG]',
  '.tar': '[ARC]',
  '.txt': '[TXT]',
  '.wav': '[AUD]',
  '.webp': '[IMG]',
  '.xml': '[CFG]',
  '.xz': '[ARC]',
  '.yaml': '[CFG]',
  '.yml': '[CFG]',
  '.zip': '[ARC]',
};

const formatSize = (size: number): string => {
  const units = ['B', 'K', 'M', 'G', 'T'];
  let value = size;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return unitIndex === 0 ? `${value}` : `${value < 10 ? value.toFixed(1) : Math.round(value)}${units[unitIndex]}`;
};

interface SortParams {
  column: string;
  order: 'A' | 'D';
}

const parseSortParams = (queryString: string): SortParams => {
  const params = new URLSearchParams(queryString.replaceAll(';', '&'));
  const column = params.get('C') ?? 'N';
  const order = params.get('O') === 'D' ? 'D' : 'A';
  return { column, order };
};

const compareFilePriority = (a: File, b: File) => {
  if (a.name === '..') {
    return -1;
  }

  if (b.name === '..') {
    return 1;
  }

  const aDir = a.stat?.isDirectory() ? 1 : 0;
  const bDir = b.stat?.isDirectory() ? 1 : 0;
  return aDir === bDir ? 0 : bDir - aDir;
};

const compareByModifiedTime = (a: File, b: File, multiplier: number) => {
  const aTime = a.stat?.mtime.getTime() ?? 0;
  const bTime = b.stat?.mtime.getTime() ?? 0;
  return (aTime - bTime) * multiplier || a.name.localeCompare(b.name);
};

const compareBySize = (a: File, b: File, multiplier: number) => {
  const aSize = a.stat?.isDirectory() ? -1 : (a.stat?.size ?? 0);
  const bSize = b.stat?.isDirectory() ? -1 : (b.stat?.size ?? 0);
  return (aSize - bSize) * multiplier || a.name.localeCompare(b.name);
};

const compareByName = (a: File, b: File, multiplier: number) => a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase()) * multiplier;

const compareSortedFiles = ({ a, b, column, multiplier }: { a: File; b: File; column: string; multiplier: number }) => {
  const priority = compareFilePriority(a, b);
  if (priority !== 0) {
    return priority;
  }

  switch (column) {
    case 'M': {
      return compareByModifiedTime(a, b, multiplier);
    }
    case 'S': {
      return compareBySize(a, b, multiplier);
    }
    default: {
      return compareByName(a, b, multiplier);
    }
  }
};

const sortFiles = (files: File[], queryString: string): File[] => {
  const { column, order } = parseSortParams(queryString);
  const multiplier = order === 'D' ? -1 : 1;
  return files.toSorted((a, b) => compareSortedFiles({ a, b, column, multiplier }));
};

const toggleOrder = (currentColumn: string, linkColumn: string, currentOrder: 'A' | 'D') => {
  const order = currentColumn === linkColumn && currentOrder === 'A' ? 'D' : 'A';
  return `?C=${linkColumn}&O=${order}`;
};

const iconLabel = (file: File) => {
  if (file.name === '..') {
    return '[UP]';
  }
  if (file.stat?.isDirectory()) {
    return '[DIR]';
  }
  return iconByExt[path.extname(file.name).toLowerCase()] ?? '[FILE]';
};

const renderFileList = function* renderFileList(files: File[], directory: string, context: RenderContext): Generator<string> {
  const { column, order } = parseSortParams(context.queryString);
  yield (
    `<span class="icon">ICON</span> <a href="${toggleOrder(column, 'N', order)}">Name</a>` +
      `${' '.repeat(20)}<a href="${toggleOrder(column, 'M', order)}">Last modified</a>      <a href="${toggleOrder(column, 'S', order)}">Size</a>  <a href="${toggleOrder(column, 'D', order)}">Description</a><hr>`
  );

  for (const file of files) {
    const icon = iconLabel(file);
    yield '\n';

    if (file.name === '..') {
      const parentHref = escapeHtml(directory.replace(/\/[^/]*\/?$/, '/'));
      yield `<span class="icon">${icon}</span> <a href="${parentHref}">Parent Directory</a>${' '.repeat(29)}-`;
    } else {
      const name = escapeHtml(file.name) + (file.stat?.isDirectory() ? '/' : '');
      const href = escapeHtml(encodeURIComponent(file.name) + (file.stat?.isDirectory() ? '/' : ''));
      const date = formatFileDate(file);
      const size = file.stat && !file.stat.isDirectory() ? formatSize(file.stat.size) : '-';
      const namePad = ' '.repeat(Math.max(1, 24 - name.length));
      const sizePad = ' '.repeat(Math.max(1, 8 - size.length));
      yield `<span class="icon">${icon}</span> <a href="${href}">${name}</a>${namePad}${date}${sizePad}${size}`;
    }
  }

  yield '\n<hr>';
};

export { renderFileList, sortFiles };
