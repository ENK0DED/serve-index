import { copyFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ignoredSourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const workspaceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceTemplatesRoot = path.join(workspaceRoot, 'src', 'templates');
const distTemplatesRoot = path.join(workspaceRoot, 'dist', 'templates');

const copyTemplateAssets = async (sourceDirectory: string, targetDirectory: string): Promise<void> => {
  await mkdir(targetDirectory, { recursive: true });

  for (const entry of await readdir(sourceDirectory, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDirectory, entry.name);
    const targetPath = path.join(targetDirectory, entry.name);

    if (entry.isDirectory()) {
      await copyTemplateAssets(sourcePath, targetPath);
    } else if (entry.isFile() && !ignoredSourceExtensions.has(path.extname(entry.name).toLowerCase())) {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
    }
  }
};

await copyTemplateAssets(sourceTemplatesRoot, distTemplatesRoot);
