import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { McpClientService } from './mcp-client.service.js';

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private openai: OpenAI;

  constructor(private readonly mcpClient: McpClientService) {
    this.openai = new OpenAI({
      apiKey:
        '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',
    });
  }

  /**
   * Convert MCP tool definitions to OpenAI function tool format
   */
  private mcpToolsToOpenAI(
    mcpTools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>,
  ): OpenAI.Chat.Completions.ChatCompletionTool[] {
    return mcpTools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description || '',
        parameters: (tool.inputSchema as Record<string, unknown>) || {
          type: 'object',
          properties: {},
        },
      },
    }));
  }

  /**
   * Run a prompt through OpenAI with MCP tools available.
   * Handles the full tool-calling loop.
   */
  async runPrompt(
    prompt: string,
    maxIterations = 10,
  ): Promise<{
    response: string;
    toolCalls: Array<{ tool: string; args: unknown; result: unknown }>;
  }> {
    // 1. Get available tools from MCP server
    const mcpTools = await this.mcpClient.listTools();
    this.logger.log(
      `Discovered ${mcpTools.length} MCP tools: ${mcpTools.map((t) => t.name).join(', ')}`,
    );

    const openaiTools = this.mcpToolsToOpenAI(mcpTools);
    const toolCallLog: Array<{ tool: string; args: unknown; result: unknown }> =
      [];

    // Filter out get_addresses tool — we hardcode the address
    const filteredTools = openaiTools.filter((t) => {
      if (t.type === 'function' && 'function' in t) {
        return (
          (t as { type: 'function'; function: { name: string } }).function
            .name !== 'get_addresses'
        );
      }
      return true;
    });

    // 2. Start conversation with the user prompt
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You are a helpful assistant with access to Swiggy tools. Use the available tools to help the user with their food ordering, restaurant search, and delivery needs. Always call tools when the user asks for something that requires fetching data or performing actions.\n\nIMPORTANT: The user\'s address_id is always "d0hfrab7gis2gb0kpm50". Never call get_addresses. Whenever a tool requires an address_id parameter, use "d0hfrab7gis2gb0kpm50".\n\nIMPORTANT: After calling search_products, ALWAYS automatically select the first product/item from the results without asking the user. Proceed immediately with that first option for any subsequent actions (e.g. adding to cart, viewing details).',
      },
      { role: 'user', content: prompt },
    ];

    // 3. Tool-calling loop
    for (let i = 0; i < maxIterations; i++) {
      const completion = await this.openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        tools: filteredTools.length > 0 ? filteredTools : undefined,
        tool_choice: filteredTools.length > 0 ? 'auto' : undefined,
      });

      const choice = completion.choices[0];
      const assistantMessage = choice.message;

      // Add assistant message to conversation
      messages.push(assistantMessage);

      // If no tool calls, we're done
      if (
        choice.finish_reason !== 'tool_calls' ||
        !assistantMessage.tool_calls ||
        assistantMessage.tool_calls.length === 0
      ) {
        return {
          response: assistantMessage.content || 'No response generated.',
          toolCalls: toolCallLog,
        };
      }

      // 4. Execute each tool call via MCP
      for (const toolCall of assistantMessage.tool_calls) {
        if (toolCall.type !== 'function') continue;
        const fn = toolCall.function;
        const toolName = fn.name;
        let toolArgs: Record<string, unknown> = {};

        try {
          toolArgs = JSON.parse(fn.arguments) as Record<string, unknown>;
        } catch {
          this.logger.warn(
            `Failed to parse tool args for ${toolName}: ${fn.arguments}`,
          );
        }

        this.logger.log(`Executing tool: ${toolName}`);

        // Inject hardcoded address_id if the tool expects it
        if ('address_id' in toolArgs || toolName.includes('address')) {
          toolArgs['address_id'] = 'd0hfrab7gis2gb0kpm50';
        }

        let toolResult: unknown;
        try {
          // Short-circuit get_addresses (shouldn't happen, but safety net)
          if (toolName === 'get_addresses') {
            toolResult = [{ id: 'd0hfrab7gis2gb0kpm50' }];
          } else {
            const mcpResult = await this.mcpClient.callTool(toolName, toolArgs);
            toolResult = mcpResult.content;
          }
        } catch (err) {
          toolResult = { error: (err as Error).message };
          this.logger.error(
            `Tool ${toolName} failed: ${(err as Error).message}`,
          );
        }

        toolCallLog.push({
          tool: toolName,
          args: toolArgs,
          result: toolResult,
        });

        // 5. Feed tool result back to OpenAI
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content:
            typeof toolResult === 'string'
              ? toolResult
              : JSON.stringify(toolResult),
        });
      }
    }

    // If we hit max iterations
    return {
      response:
        'Reached maximum tool-calling iterations. Last state of conversation is preserved.',
      toolCalls: toolCallLog,
    };
  }

  /**
   * Get available tools (for debugging / discovery)
   */
  async getAvailableTools() {
    const tools = await this.mcpClient.listTools();
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.inputSchema,
    }));
  }
}
