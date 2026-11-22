import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import OpenAI from 'openai';
import { loadConfig} from './config.ts';
import { runAgentTurn } from './agent.ts';

const SYSTEM_PROMPT =
  '你是一个运行在终端里的 Coding Agent。当用户询问当前项目的问题时，不要凭空猜测，先调用 list_dir 和 read_file 查看实际文件后再回答。请用简洁清晰的中文回复。';
const Config = loadConfig();

const apiKey = Config.apiKey;
const baseURL = Config.baseURL;
const model = Config.model;

const client = new OpenAI({
    apiKey,
    baseURL,
});

const history: OpenAI.Responses.ResponseInputItem[] = [];
const rl = readline.createInterface({ input: stdin, output: stdout });

console.log('对话已开始，输入 /exit 退出。');

let isExiting = false;
function handleExit(): void {
  if (isExiting) return;
  isExiting = true;
  console.log('\n再见！');
  rl.close();
  process.exit(0);
}
// 1. 打字时（rl 接管终端），由 rl 接住 Ctrl+C
rl.on('SIGINT', handleExit);
// 2. AI 正在回复时，由 process 兜底接住 Ctrl+C
process.on('SIGINT', handleExit);

try {
  while (true) {
    const rawInput = await rl.question('\n你> ');
    const userInput = rawInput.trim();
    if (!userInput) {
      continue; // 直接按回车就跳过，不发空请求
    }
    if (userInput === '/exit' || userInput === 'exit') {
      break;
    }
    const savedHistoryLength = history.length;
    history.push({ role: 'user', content: userInput });

    try {
      await runAgentTurn({
        client,
        model,
        instructions: SYSTEM_PROMPT,
        history,
      });
    } catch (error: unknown) {
      // 整轮原子回滚，防止半截 function_call 污染上下文
      history.length = savedHistoryLength;
      const message = error instanceof Error ? error.message : String(error);
      console.error(`\n[请求失败] ${message}`);
    }
  }
} finally {
  rl.close();
}

/*
补充：
现代 JavaScript 的 ES Modules 支持 Top-level await（顶层 await）
也就是说，在 ES Module 的顶层作用域中，可以直接使用 await，不需要额外包裹 async function
*/