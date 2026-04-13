import { realpath } from 'node:fs/promises';
import path from 'node:path';

const isContainedPath = (rootPath: string, candidatePath: string): boolean => {
  const relativePath = path.relative(rootPath, candidatePath);
  return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
};

class PathEscapeError extends Error {
  override readonly name = 'PathEscapeError';
  readonly code = 'EPATHESCAPE';
  constructor() {
    super('Path escapes root');
  }
}

const resolveContainedPath = async (rootRealPath: string, candidatePath: string): Promise<string> => {
  const resolvedPath = await realpath(candidatePath);

  if (!isContainedPath(rootRealPath, resolvedPath)) {
    throw new PathEscapeError();
  }

  return resolvedPath;
};

const isHiddenSegment = (segment: string): boolean => segment.startsWith('.') && segment !== '.' && segment !== '..';

const hasHiddenPathSegment = (pathname: string): boolean => pathname.split('/').some(isHiddenSegment);

const hasHiddenResolvedPath = (rootRealPath: string, resolvedPath: string): boolean => {
  const relativePath = path.relative(rootRealPath, resolvedPath);
  return relativePath !== '' && relativePath !== '.' && relativePath.split(path.sep).some(isHiddenSegment);
};

export { PathEscapeError, hasHiddenPathSegment, hasHiddenResolvedPath, isContainedPath, resolveContainedPath };
