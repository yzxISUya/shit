export interface AppConfig {
  readonly apiKey: string;
  readonly baseURL?: string;
  readonly model: string;
}

export function loadConfig(): AppConfig {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('缺少环境变量 OPENAI_API_KEY，请检查 .env 文件');
  }

  const baseURL = process.env.OPENAI_BASE_URL?.trim() || 'https://api.deepseek.com'

  const model = process.env.OPENAI_MODEL?.trim() || 'deepseek-chat';

  return {
    apiKey,
    baseURL,
    model,
  };
}