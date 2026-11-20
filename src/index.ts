import * as readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import OpenAI from 'openai';
import { loadConfig} from './config.ts';

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
    // 1. 记录用户输入
    history.push({ role: 'user', content: userInput });
    try {
        // 2. 把完整 history 发给 Responses API
        const stream = await client.responses.create({
        model,
        instructions: '你是个美女',
        input: history,
        stream: true,
        store: false,
        });
        process.stdout.write('AI> ');
        let assistantText = '';
        for await (const event of stream) {
        if (event.type === 'response.output_text.delta') {
            process.stdout.write(event.delta);
            assistantText += event.delta;
        }
        }
        process.stdout.write('\n');

        if (assistantText) {
        history.push({ role: 'assistant', content: assistantText });
        }
    } catch (error: unknown) {
      history.pop();
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