import type OpenAI from 'openai';
import { executeTool, toolDefinitions } from './tool.ts';

export interface RunAgentOptions {
  readonly client: OpenAI;
  readonly model: string;
  readonly instructions: string;
  readonly history: OpenAI.Responses.ResponseInputItem[];
  readonly maxSteps?: number;
}

export async function runAgentTurn(options: RunAgentOptions): Promise<void> {
  const { client, model, instructions, history, maxSteps = 10 } = options;

  for (let step = 1; step <= maxSteps; step++) {
    const stream = await client.responses.create({
      model,
      instructions,
      input: history,
      tools: toolDefinitions, // 把工具“菜单”交给模型
      stream: true,
      store: false,
    });

    let assistantText = '';
    let hasPrintedPrefix = false;
    const functionCalls: OpenAI.Responses.ResponseFunctionToolCall[] = [];

    for await (const event of stream) {
      if (event.type === 'response.output_text.delta') {
        if (!hasPrintedPrefix) {
          process.stdout.write('\nAI> ');
          hasPrintedPrefix = true;
        }
        process.stdout.write(event.delta);
        assistantText += event.delta;
      } else if (
        event.type === 'response.output_item.done' &&
        event.item.type === 'function_call'
      ) {
        functionCalls.push(event.item);
      }
    }

    if (hasPrintedPrefix) {
      process.stdout.write('\n');
    }

    if (assistantText) {
      history.push({ role: 'assistant', content: assistantText });
    }

    // 没有工具调用 → 本轮任务完成，退出 Agent Loop！
    if (functionCalls.length === 0) {
      return;
    }

    // 有工具调用 → 执行并成对写回 history，然后进入下一轮 loop
    for (const call of functionCalls) {
      history.push({
        type: 'function_call',
        call_id: call.call_id,
        name: call.name,
        arguments: call.arguments,
      });

      console.log(`\n[步骤 ${step} · 调用工具] ${call.name}(${call.arguments})`);
      const result = await executeTool(call.name, call.arguments);
      console.log(`[工具返回] 共 ${result.length} 字符`);

      history.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: result,
      });
    }
  }

  console.warn(`\n[警告] 已达到最大工具调用轮数 (${maxSteps})，自动停止。`);
}