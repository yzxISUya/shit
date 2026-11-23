import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type OpenAI from 'openai';

export const toolDefinitions: OpenAI.Responses.FunctionTool[] = [
  {
    type: 'function',
    name: 'list_dir',
    description: '列出指定目录下的文件和子目录（自动忽略 node_modules 和 .git）',
    parameters: {
      type: 'object',
      properties: {
        dirPath: {
          type: 'string',
          description: '目录路径（相对当前项目根目录），不传默认 "."',
        },
      },
      required: [],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'read_file',
    description: '读取文本文件内容（带行号），支持按行号范围分段读取',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '要读取的文件路径（相对当前项目根目录）',
        },
        startLine: {
          type: 'number',
          description: '起始行号（从 1 开始，可选）',
        },
        endLine: {
          type: 'number',
          description: '结束行号（包含该行，可选）',
        },
      },
      required: ['filePath'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'search_text',
    description: '在项目文件中递归搜索指定文本（不区分大小写），返回匹配的文件路径、行号和该行内容',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '要搜索的关键词文本',
        },
        dirPath: {
          type: 'string',
          description: '限制搜索的起始目录（相对项目根目录），不传则搜索整个项目 "."',
        },
      },
      required: ['query'],
    },
    strict: false,
  },
  {
    type: 'function',
    name: 'write_file',
    description:
      '创建新文件或完整覆写已有文件（自动创建不存在的父目录）。仅用于新建文件或整文件重写；局部修改已有文件请优先使用 edit_file',
    parameters: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: '要写入的文件路径（相对当前项目根目录）',
        },
        content: {
          type: 'string',
          description: '要写入的完整文本内容',
        },
      },
      required: ['filePath', 'content'],
    },
    strict: false,
  },
];

const WORKSPACE_ROOT = path.resolve(process.cwd());

const IGNORED_DIRS = new Set(['node_modules', '.git']);

function isSecretSegment(segment: string): boolean {
  const lower = segment.toLowerCase();
  return lower === '.env' || (lower.startsWith('.env.') && lower !== '.env.example');
}

export function resolveSafePath(
  inputPath: string,
  mode: 'read' | 'write' = 'read',
): string {
  const resolved = path.resolve(WORKSPACE_ROOT, inputPath);
  const relative = path.relative(WORKSPACE_ROOT, resolved);
  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`安全拦截：不允许访问工作区之外的路径 (${inputPath})`);
  }

  if (relative !== '') {
    const segments = relative.split(path.sep);
    if (segments.some(isSecretSegment)) {
      throw new Error(`安全拦截：不允许访问敏感环境变量文件 (${inputPath})`);
    }
    if (mode === 'write' && segments.some((s) => IGNORED_DIRS.has(s.toLowerCase()))) {
      throw new Error(`安全拦截：不允许直接修改受保护目录 (${inputPath})`);
    }
  }

  return resolved;
}

async function listDir(dirPath: string): Promise<string> {
  const targetDir = resolveSafePath(dirPath);
  const entries = await fs.readdir(targetDir, { withFileTypes: true });

  const lines = entries
    .filter((entry) => !isSecretSegment(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));

  if (lines.length === 0) {
    return '(空目录)';
  }
  return lines.join('\n');
}

async function readFileWithLines(
  filePath: string,
  startLine?: number,
  endLine?: number,
): Promise<string> {
  const targetFile = resolveSafePath(filePath);
  const content = await fs.readFile(targetFile, 'utf-8');
  const allLines = content.split(/\r?\n/);

  const start = Math.max(1, Math.floor(startLine ?? 1));
  // 默认单次最多读 200 行，防止超大文件撑爆上下文
  const end = Math.min(allLines.length, Math.floor(endLine ?? start + 199));

  if (start > allLines.length) {
    return `文件共 ${allLines.length} 行，起始行 ${start} 超出范围。`;
  }

  const numbered: string[] = [];
  for (let i = start; i <= end; i++) {
    // noUncheckedIndexedAccess 下 allLines[i - 1] 是 string | undefined
    const line = allLines[i - 1] ?? '';
    numbered.push(`${i}: ${line}`);
  }

  return `文件: ${filePath} (第 ${start}-${end} 行 / 共 ${allLines.length} 行)\n${numbered.join('\n')}`;
}

const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_FILE_BYTES = 1024 * 1024; // 跳过超过 1MB 的文件

async function searchText(query: string, dirPath: string): Promise<string> {
  const startDir = resolveSafePath(dirPath);
  const matches: string[] = [];
  const lowerQuery = query.toLowerCase();

  async function walk(currentDir: string): Promise<void> {
    if (matches.length >= MAX_SEARCH_RESULTS) {
      return;
    }

    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (matches.length >= MAX_SEARCH_RESULTS) {
        return;
      }
      if (isSecretSegment(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        if (stat.size > MAX_SEARCH_FILE_BYTES) {
          continue;
        }

        const content = await fs.readFile(fullPath, 'utf-8');
        // 简单跳过二进制文件（二进制内容通常包含空字节 \0）
        if (content.includes('\0')) {
          continue;
        }

        const lines = content.split(/\r?\n/);
        const relPath = path.relative(WORKSPACE_ROOT, fullPath);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          if (line.toLowerCase().includes(lowerQuery)) {
            matches.push(`${relPath}:${i + 1}: ${line.trim()}`);
            if (matches.length >= MAX_SEARCH_RESULTS) {
              return;
            }
          }
        }
      }
    }
  }

  await walk(startDir);

  if (matches.length === 0) {
    return `未找到包含 "${query}" 的内容。`;
  }
  const suffix =
    matches.length >= MAX_SEARCH_RESULTS
      ? `\n... (已达到单次最大显示条数 ${MAX_SEARCH_RESULTS}，请缩小搜索范围)`
      : '';
  return matches.join('\n') + suffix;
}

async function writeFileContent(filePath: string, content: string): Promise<string> {
  const targetFile = resolveSafePath(filePath);

  let existed = true;
  try {
    await fs.access(targetFile);
  } catch {
    existed = false;
  }

  await fs.mkdir(path.dirname(targetFile), { recursive: true });
  await fs.writeFile(targetFile, content, 'utf-8');

  const lineCount = content === '' ? 0 : content.split(/\r?\n/).length;
  const byteCount = Buffer.byteLength(content, 'utf-8');
  const action = existed ? '已覆写' : '已创建';
  return `${action}文件: ${filePath}（共 ${lineCount} 行，${byteCount} 字节）`;
}

// 统一调度入口：解析参数、校验类型、捕获异常并返回字符串给模型
export async function executeTool(name: string, rawArgs: string): Promise<string> {
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawArgs || '{}');
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return '工具参数错误：参数必须是一个 JSON 对象';
    }
    args = parsed as Record<string, unknown>;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return `工具参数 JSON 解析失败：${msg}`;
  }

  try {
    if (name === 'list_dir') {
      const dirPath =
        typeof args['dirPath'] === 'string' && args['dirPath'].trim()
          ? args['dirPath'].trim()
          : '.';
      return await listDir(dirPath);
    }

    if (name === 'read_file') {
      const filePath = args['filePath'];
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return '工具参数错误：read_file 必须提供非空字符串 filePath';
      }
      const startLine = typeof args['startLine'] === 'number' ? args['startLine'] : undefined;
      const endLine = typeof args['endLine'] === 'number' ? args['endLine'] : undefined;
      return await readFileWithLines(filePath.trim(), startLine, endLine);
    }

    if (name === 'search_text') {
      const query = args['query'];
      if (typeof query !== 'string' || !query.trim()) {
        return '工具参数错误：search_text 必须提供非空字符串 query';
      }
      const dirPath =
        typeof args['dirPath'] === 'string' && args['dirPath'].trim()
          ? args['dirPath'].trim()
          : '.';
      return await searchText(query.trim(), dirPath);
    }

    if (name === 'write_file') {
      const filePath = args['filePath'];
      if (typeof filePath !== 'string' || !filePath.trim()) {
        return '工具参数错误：write_file 必须提供非空字符串 filePath';
      }
      const content = args['content'];
      if (typeof content !== 'string') {
        return '工具参数错误：write_file 必须提供字符串类型的 content';
      }
      return await writeFileContent(filePath.trim(), content);
    }

    return `未知工具：${name}`;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return `工具执行失败：${msg}`;
  }
}