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
];

const IGNORED_DIRS = new Set(['node_modules', '.git']);

async function listDir(dirPath: string): Promise<string> {
  const targetDir = path.resolve(process.cwd(), dirPath);
  const entries = await fs.readdir(targetDir, { withFileTypes: true });

  const lines = entries
    .filter((entry) => !IGNORED_DIRS.has(entry.name))
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
  const targetFile = path.resolve(process.cwd(), filePath);
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

    return `未知工具：${name}`;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return `工具执行失败：${msg}`;
  }
}