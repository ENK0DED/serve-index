import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileTemplate } from '../src/template.ts';
import { renderFileList as renderApacheList } from '../src/templates/apache/index.ts';
import { renderFileList as renderExpressList } from '../src/templates/express/index.ts';
import { renderFileList as renderNginxList } from '../src/templates/nginx/index.ts';
import type { File, PresetRenderer, RenderContext, TemplatePart } from '../src/types.ts';

const textEncoder = new TextEncoder();
const workspaceRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const templateRoot = path.join(workspaceRoot, 'src', 'templates');
const benchmarkTemplateAssetUrl = (assetPath: string) => `?__serve_index_asset=${encodeURIComponent(assetPath)}`;

interface BenchmarkFixture {
  directoryStat: NonNullable<File['stat']>;
  fileStat: NonNullable<File['stat']>;
}

interface BenchmarkConfig {
  directory: string;
  host: string;
  renderContext: RenderContext;
  renderer: PresetRenderer;
  templateContent: string;
}

interface BenchmarkResult {
  elapsedMs: number;
  materializedBytes: number;
  outputBytes: number;
}

interface BenchmarkRunOptions {
  iterations: number;
  name: string;
  run: () => BenchmarkResult;
  warmups: number;
}

const parseNumberFlag = (flag: string, fallback: number) => {
  const index = process.argv.indexOf(flag);
  const rawValue = index !== -1 ? process.argv[index + 1] : undefined;
  const parsed = rawValue ? Number(rawValue) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const createMockFile = (index: number, fixture: BenchmarkFixture): File => {
  const directory = index % 5 === 0;
  const name = directory ? `dir-${index.toString().padStart(5, '0')}` : `file-${index.toString().padStart(5, '0')}.txt`;

  return { name, stat: directory ? fixture.directoryStat : fixture.fileStat };
};

const buildFiles = (count: number, fixture: BenchmarkFixture): File[] => {
  const files: File[] = [{ name: '..', stat: undefined }];
  for (let index = 0; index < count; index += 1) {
    files.push(createMockFile(index, fixture));
  }

  return files;
};

const toMarkupString = (markup: ReturnType<PresetRenderer>) => (typeof markup === 'string' ? markup : [...markup].join(''));

const iterateMarkup = (markup: ReturnType<PresetRenderer>) => (typeof markup === 'string' ? [markup] : markup);

const renderBuffered = (config: BenchmarkConfig, files: File[]): BenchmarkResult => {
  const start = performance.now();
  const filesMarkup = toMarkupString(config.renderer(files, config.directory, config.renderContext));
  const html = config.templateContent
    .replaceAll('{style}', '')
    .replaceAll('{files}', filesMarkup)
    .replaceAll('{directory}', config.directory)
    .replaceAll('{linked-path}', config.directory)
    .replaceAll('{nonce}', 'bench')
    .replaceAll('{signature}', 'Apache Server at example.test Port 80')
    .replaceAll('{host}', config.host);
  const elapsedMs = performance.now() - start;

  return {
    elapsedMs,
    materializedBytes: textEncoder.encode(filesMarkup).byteLength + textEncoder.encode(html).byteLength,
    outputBytes: textEncoder.encode(html).byteLength,
  };
};

const renderStreamed = (config: BenchmarkConfig, templateParts: TemplatePart[], files: File[]): BenchmarkResult => {
  const start = performance.now();
  const filesMarkup = config.renderer(files, config.directory, config.renderContext);
  const replacements = {
    directory: config.directory,
    files: filesMarkup,
    host: config.host,
    'linked-path': config.directory,
    nonce: 'bench',
    signature: 'Apache Server at example.test Port 80',
    style: '',
  } as const;

  let outputBytes = 0;
  let materializedBytes = 0;

  for (const part of templateParts) {
    if (part.type === 'text') {
      const chunkBytes = textEncoder.encode(part.value).byteLength;
      outputBytes += chunkBytes;
      materializedBytes = Math.max(materializedBytes, chunkBytes);
    } else if (part.value === 'files') {
      for (const chunk of iterateMarkup(replacements.files)) {
        const chunkBytes = textEncoder.encode(chunk).byteLength;
        outputBytes += chunkBytes;
        materializedBytes = Math.max(materializedBytes, chunkBytes);
      }
    } else {
      const chunkBytes = textEncoder.encode(replacements[part.value]).byteLength;
      outputBytes += chunkBytes;
      materializedBytes = Math.max(materializedBytes, chunkBytes);
    }
  }

  return {
    elapsedMs: performance.now() - start,
    materializedBytes,
    outputBytes,
  };
};

const benchmark = ({ iterations, name, run, warmups }: BenchmarkRunOptions) => {
  for (let index = 0; index < warmups; index += 1) {
    run();
  }

  let elapsedMs = 0;
  let materializedBytes = 0;
  let outputBytes = 0;

  for (let index = 0; index < iterations; index += 1) {
    const result = run();
    const { materializedBytes: nextMaterializedBytes, outputBytes: nextOutputBytes } = result;
    elapsedMs += result.elapsedMs;
    materializedBytes = nextMaterializedBytes;
    outputBytes = nextOutputBytes;
  }

  return {
    iterations,
    materializedBytes,
    msPerIteration: elapsedMs / iterations,
    name,
    outputBytes,
  };
};

const formatBytes = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  return `${(bytes / 1024).toFixed(1)} KiB`;
};

const loadBenchmarkConfigs = async (): Promise<Record<string, BenchmarkConfig>> => {
  const [expressTemplate, apacheTemplate, nginxTemplate] = await Promise.all([
    readFile(path.join(templateRoot, 'express', 'directory.html'), 'utf8'),
    readFile(path.join(templateRoot, 'apache', 'directory.html'), 'utf8'),
    readFile(path.join(templateRoot, 'nginx', 'directory.html'), 'utf8'),
  ]);

  return {
    apache: {
      directory: '/assets/nested/',
      host: 'example.test',
      renderContext: { queryString: 'C=N;O=A', templateAssetUrl: benchmarkTemplateAssetUrl, viewName: 'tiles' },
      renderer: renderApacheList,
      templateContent: apacheTemplate,
    },
    express: {
      directory: '/assets/nested/',
      host: 'example.test',
      renderContext: { queryString: '', templateAssetUrl: benchmarkTemplateAssetUrl, viewName: 'details' },
      renderer: renderExpressList,
      templateContent: expressTemplate,
    },
    nginx: {
      directory: '/assets/nested/',
      host: 'example.test',
      renderContext: { queryString: '', templateAssetUrl: benchmarkTemplateAssetUrl, viewName: 'tiles' },
      renderer: renderNginxList,
      templateContent: nginxTemplate,
    },
  };
};

const createBenchmarkFixture = async (): Promise<BenchmarkFixture> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'serve-index-bench-'));

  try {
    const directoryPath = path.join(root, 'dir');
    const filePath = path.join(root, 'file.txt');
    await mkdir(directoryPath);
    await writeFile(filePath, 'benchmark fixture');

    const [directoryStat, fileStat] = await Promise.all([lstat(directoryPath), lstat(filePath)]);
    return { directoryStat, fileStat };
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

const entries = parseNumberFlag('--entries', 5000);
const iterations = parseNumberFlag('--iterations', 20);
const warmups = parseNumberFlag('--warmups', 3);
const fixture = await createBenchmarkFixture();
const files = buildFiles(entries, fixture);
const configs = await loadBenchmarkConfigs();

/* eslint-disable no-console */
console.log(`HTML rendering benchmark with ${entries.toLocaleString()} entries, ${warmups} warmups, ${iterations} measured iterations.`);
console.log('');

for (const [preset, config] of Object.entries(configs)) {
  const templateParts = compileTemplate(config.templateContent);
  const buffered = benchmark({ iterations, name: `${preset}:buffered`, run: () => renderBuffered(config, files), warmups });
  const streamed = benchmark({ iterations, name: `${preset}:streamed`, run: () => renderStreamed(config, templateParts, files), warmups });
  const delta = ((streamed.msPerIteration - buffered.msPerIteration) / buffered.msPerIteration) * 100;

  console.log(preset);
  console.log(
    `  buffered: ${buffered.msPerIteration.toFixed(2)} ms/iter, output ${formatBytes(buffered.outputBytes)}, materialized ${formatBytes(buffered.materializedBytes)}`,
  );
  console.log(
    `  streamed: ${streamed.msPerIteration.toFixed(2)} ms/iter, output ${formatBytes(streamed.outputBytes)}, largest chunk ${formatBytes(streamed.materializedBytes)}`,
  );
  console.log(`  delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`);
  console.log('');
}
/* eslint-enable no-console */
