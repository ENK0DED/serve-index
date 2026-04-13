import type { File } from './types.js';
import { escapeHtml } from './utils.js';

export const formatFileDate = (file: File, includeSeconds = false): string => {
  if (!file.stat || file.name === '..') {
    return '';
  }

  const d = file.stat.mtime;
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hour = String(d.getHours()).padStart(2, '0');
  const minute = String(d.getMinutes()).padStart(2, '0');

  if (includeSeconds) {
    const second = String(d.getSeconds()).padStart(2, '0');
    return `${d.getFullYear()}-${month}-${day} ${hour}:${minute}:${second}`;
  }

  return `${d.getFullYear()}-${month}-${day} ${hour}:${minute}`;
};

export const fileEntryHref = (file: File, directory: string): string => {
  if (file.name === '..') {
    const normalizedDirectory = directory.endsWith('/') && directory !== '/' ? directory.slice(0, -1) : directory;
    const parentDirectory = normalizedDirectory.replace(/\/[^/]*$/, '') || '/';
    return escapeHtml(parentDirectory.endsWith('/') ? parentDirectory : `${parentDirectory}/`);
  }

  const normalizedDirectory = directory.endsWith('/') ? directory : `${directory}/`;
  const suffix = file.stat?.isDirectory() ? '/' : '';
  return escapeHtml(`${normalizedDirectory}${encodeURIComponent(file.name)}${suffix}`.replaceAll('\\', '/'));
};
