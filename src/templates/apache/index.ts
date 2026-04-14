import path from 'node:path';

import { formatFileDate } from '../../template-helpers.js';
import type { File, RenderContext } from '../../types.js';
import { escapeHtml } from '../../utils.js';

interface ApacheIcon {
  altText?: string;
  assetPath: string;
}

interface SortParams {
  column: string;
  order: 'A' | 'D';
}

const defaultNameWidth = 23;
const versionCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const indexIgnorePatterns = ['.??*', '*~', '*#', 'HEADER*', 'README*', 'RCS', 'CVS', '*,v', '*,t'] as const;

const defaultFileIcon: ApacheIcon = { assetPath: 'icons/unknown.gif' };

const exactIconByName: Record<string, ApacheIcon> = {
  README: { assetPath: 'icons/hand.right.gif' },
  core: { assetPath: 'icons/bomb.gif' },
};

const iconByExt: Record<string, ApacheIcon> = {
  '.Z': { assetPath: 'icons/compressed.gif' },
  '.ai': { assetPath: 'icons/a.gif' },
  '.bin': { assetPath: 'icons/binary.gif' },
  '.c': { assetPath: 'icons/c.gif' },
  '.conf': { assetPath: 'icons/script.gif' },
  '.csh': { assetPath: 'icons/script.gif' },
  '.dvi': { assetPath: 'icons/dvi.gif' },
  '.eps': { assetPath: 'icons/a.gif' },
  '.exe': { assetPath: 'icons/binary.gif' },
  '.for': { assetPath: 'icons/f.gif' },
  '.gz': { assetPath: 'icons/compressed.gif' },
  '.hqx': { assetPath: 'icons/binhex.gif' },
  '.htm': { assetPath: 'icons/layout.gif' },
  '.html': { assetPath: 'icons/layout.gif' },
  '.iv': { assetPath: 'icons/world2.gif' },
  '.ksh': { assetPath: 'icons/script.gif' },
  '.pdf': { assetPath: 'icons/layout.gif' },
  '.pl': { assetPath: 'icons/p.gif' },
  '.ps': { assetPath: 'icons/a.gif' },
  '.py': { assetPath: 'icons/p.gif' },
  '.sh': { assetPath: 'icons/script.gif' },
  '.shar': { assetPath: 'icons/script.gif' },
  '.shtml': { assetPath: 'icons/layout.gif' },
  '.tar': { assetPath: 'icons/tar.gif' },
  '.tcl': { assetPath: 'icons/script.gif' },
  '.tex': { assetPath: 'icons/tex.gif' },
  '.tgz': { assetPath: 'icons/compressed.gif' },
  '.txt': { assetPath: 'icons/text.gif' },
  '.uu': { assetPath: 'icons/uuencoded.gif' },
  '.vrm': { assetPath: 'icons/world2.gif' },
  '.vrml': { assetPath: 'icons/world2.gif' },
  '.wrl': { assetPath: 'icons/world2.gif' },
  '.z': { assetPath: 'icons/compressed.gif' },
  '.zip': { assetPath: 'icons/compressed.gif' },
};

const compressedExts = new Set(['.bz2', '.gz', '.xz']);
const imageExts = new Set(['.avif', '.bmp', '.gif', '.heic', '.jpeg', '.jpg', '.png', '.svg', '.tif', '.tiff', '.webp']);
const audioExts = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav']);
const videoExts = new Set(['.avi', '.mkv', '.mov', '.mp4', '.mpeg', '.mpg', '.webm']);

const globToRegExp = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
      .replaceAll('*', '.*')
      .replaceAll('?', '.')}$`,
  );

const shouldIgnoreFile = (file: File): boolean => {
  if (file.name === '..') {
    return false;
  }

  return indexIgnorePatterns.some((pattern) => globToRegExp(pattern).test(file.name));
};

const formatApacheSize = (size: number): string => {
  if (size < 0) {
    return '  - ';
  }
  if (size < 973) {
    return `${size.toString().padStart(3, ' ')} `;
  }

  const units = 'KMGTPE';
  let value = size;

  for (const unit of units) {
    const remain = value % 1024;
    value = Math.floor(value / 1024);

    if (value < 973) {
      if (value < 9 || (value === 9 && remain < 973)) {
        let decimal = Math.floor((remain * 5 + 256) / 512);
        let whole = value;
        if (decimal >= 10) {
          whole += 1;
          decimal = 0;
        }
        return `${whole}.${decimal}${unit}`;
      }

      const whole = remain >= 512 ? value + 1 : value;
      return `${whole.toString().padStart(3, ' ')}${unit}`;
    }
  }

  return '****';
};

const truncateName = (name: string, width: number): string => {
  if (name.length <= width) {
    return name;
  }
  return `${name.slice(0, Math.max(0, width - 3))}..>`;
};

const parseSortParams = (queryString: string): SortParams => {
  const params = new URLSearchParams(queryString.replaceAll(';', '&'));
  const column = params.get('C') ?? 'N';
  const order = params.get('O') === 'D' ? 'D' : 'A';
  return { column, order };
};

const compareParentPriority = (a: File, b: File) => {
  if (a.name === '..') {
    return -1;
  }

  if (b.name === '..') {
    return 1;
  }

  return 0;
};

const compareByName = (a: File, b: File, multiplier: number) => versionCollator.compare(a.name, b.name) * multiplier;

const compareByModifiedTime = (a: File, b: File, multiplier: number) => {
  const aTime = a.stat?.mtime.getTime() ?? 0;
  const bTime = b.stat?.mtime.getTime() ?? 0;
  return (aTime - bTime) * multiplier || compareByName(a, b, 1);
};

const compareBySize = (a: File, b: File, multiplier: number) => {
  const aSize = a.stat?.isDirectory() ? -1 : (a.stat?.size ?? 0);
  const bSize = b.stat?.isDirectory() ? -1 : (b.stat?.size ?? 0);
  return (aSize - bSize) * multiplier || compareByName(a, b, 1);
};

const compareSortedFiles = ({ a, b, column, multiplier }: { a: File; b: File; column: string; multiplier: number }) => {
  const parentPriority = compareParentPriority(a, b);
  if (parentPriority !== 0) {
    return parentPriority;
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

const filterFiles = (files: File[]): File[] => files.filter((file) => !shouldIgnoreFile(file));

const toggleOrder = (currentColumn: string, linkColumn: string, currentOrder: 'A' | 'D') => {
  const order = currentColumn === linkColumn && currentOrder === 'A' ? 'D' : 'A';
  return `?C=${linkColumn};O=${order}`;
};

const iconForFile = (file: File): ApacheIcon => {
  if (file.name === '..') {
    return { altText: 'PARENTDIR', assetPath: 'icons/back.gif' };
  }
  if (file.stat?.isDirectory()) {
    return { altText: 'DIR', assetPath: 'icons/folder.gif' };
  }

  const exactIcon = exactIconByName[file.name];
  if (exactIcon) {
    return exactIcon;
  }

  const extension = path.extname(file.name);
  const normalizedExtension = extension.toLowerCase();
  if (iconByExt[extension]) {
    return iconByExt[extension];
  }
  if (iconByExt[normalizedExtension]) {
    return iconByExt[normalizedExtension];
  }
  if (compressedExts.has(normalizedExtension)) {
    return { assetPath: 'icons/compressed.gif' };
  }
  if (imageExts.has(normalizedExtension)) {
    return { altText: 'IMG', assetPath: 'icons/image2.gif' };
  }
  if (audioExts.has(normalizedExtension)) {
    return { altText: 'SND', assetPath: 'icons/sound2.gif' };
  }
  if (videoExts.has(normalizedExtension)) {
    return { altText: 'VID', assetPath: 'icons/movie.gif' };
  }

  return defaultFileIcon;
};

const formatAltText = (altText?: string) => `[${altText ?? '   '}]`;

const renderIcon = (icon: ApacheIcon, context: RenderContext) =>
  `<img src="${escapeHtml(context.templateAssetUrl(icon.assetPath))}" alt="${escapeHtml(formatAltText(icon.altText))}">`;

const blankHeaderIcon = (context: RenderContext) => renderIcon({ altText: 'ICO', assetPath: 'icons/blank.gif' }, context);

const renderFileList = function* renderFileList(files: File[], directory: string, context: RenderContext): Generator<string> {
  const { column, order } = parseSortParams(context.queryString);
  const nameWidth = Math.max(
    defaultNameWidth,
    ...files.map((file) => (file.name === '..' ? 'Parent Directory'.length : (file.name + (file.stat?.isDirectory() ? '/' : '')).length)),
  );

  yield '  <table>\n';
  yield `   <tr><th valign="top">${blankHeaderIcon(context)}</th><th><a href="${toggleOrder(column, 'N', order)}">Name</a></th><th><a href="${toggleOrder(column, 'M', order)}">Last modified</a></th><th><a href="${toggleOrder(column, 'S', order)}">Size</a></th><th><a href="${toggleOrder(column, 'D', order)}">Description</a></th></tr>\n`;
  yield '   <tr><th colspan="5"><hr></th></tr>\n';

  for (const file of files) {
    const icon = iconForFile(file);

    if (file.name === '..') {
      const href = escapeHtml(`${directory.endsWith('/') ? directory : `${directory}/`}../`);
      const label = 'Parent Directory';
      yield `<tr><td valign="top">${renderIcon(icon, context)}</td><td><a href="${href}">${label}</a>${' '.repeat(Math.max(0, nameWidth - label.length))}</td><td align="right">&nbsp;</td><td align="right">  - </td><td>&nbsp;</td></tr>\n`;
    } else {
      const fullName = file.name + (file.stat?.isDirectory() ? '/' : '');
      const label = truncateName(fullName, nameWidth);
      const href = escapeHtml(encodeURIComponent(file.name) + (file.stat?.isDirectory() ? '/' : ''));
      const date = formatFileDate(file);
      const size = file.stat && !file.stat.isDirectory() ? formatApacheSize(file.stat.size) : '  - ';
      yield `<tr><td valign="top">${renderIcon(icon, context)}</td><td><a href="${href}">${escapeHtml(label)}</a>${' '.repeat(Math.max(0, nameWidth - label.length))}</td><td align="right">${date}  </td><td align="right">${size}</td><td>&nbsp;</td></tr>\n`;
    }
  }

  yield '   <tr><th colspan="5"><hr></th></tr>\n';
  yield '</table>';
};

export { filterFiles, renderFileList, sortFiles };
