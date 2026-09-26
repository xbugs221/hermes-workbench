/**
 * 文件目的：定义 Workbench 会话分组和工具卡片所需的最小消息合同。
 * 业务边界：只保留当前渲染链路使用的字段，避免依赖任何外部聊天应用。
 */

export interface ToolResult {
  content?: unknown;
  isError?: boolean;
  timestamp?: string | number | Date;
  [key: string]: unknown;
}

export interface ChatTokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface ChatMessage {
  type: string;
  content?: string;
  timestamp: string | number | Date;
  phase?: string;
  messageKey?: string;
  isThinking?: boolean;
  isTaskNotification?: boolean;
  taskKind?: string;
  taskStatus?: string;
  model?: string;
  tokenUsage?: ChatTokenUsage;
  isStreaming?: boolean;
  isToolUse?: boolean;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult | null;
  toolId?: string;
  toolCallId?: string;
  isSubagentContainer?: boolean;
  source?: string;
  unmatched?: boolean;
  [key: string]: unknown;
}
