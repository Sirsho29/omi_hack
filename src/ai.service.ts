import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import OpenAI from 'openai';
import { McpClientService } from './mcp-client.service.js';

export interface AiEvent {
  type:
    | 'thinking'
    | 'tool_call'
    | 'tool_result'
    | 'response'
    | 'error'
    | 'transcript';
  message: string;
  data?: unknown;
  timestamp: string;
}

@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private openai: OpenAI;
  public readonly events = new EventEmitter();

  constructor(private readonly mcpClient: McpClientService) {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY || '',
    });
  }

  emitEvent(type: AiEvent['type'], message: string, data?: unknown) {
    const event: AiEvent = {
      type,
      message,
      data,
      timestamp: new Date().toISOString(),
    };
    this.events.emit('event', event);
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
    this.emitEvent(
      'thinking',
      'Connecting to Swiggy and discovering available tools...',
    );
    const mcpTools = await this.mcpClient.listTools();
    this.logger.log(
      `Discovered ${mcpTools.length} MCP tools: ${mcpTools.map((t) => t.name).join(', ')}`,
    );
    this.emitEvent(
      'thinking',
      `Found ${mcpTools.length} Swiggy tools available`,
    );

    const openaiTools = this.mcpToolsToOpenAI(mcpTools);
    const toolCallLog: Array<{ tool: string; args: unknown; result: unknown }> =
      [];

    // Filter out tools we don't want the LLM to use
    const blockedTools = new Set([
      'get_addresses',
      'create_cart',
      'add_to_cart',
    ]);
    const filteredTools = openaiTools.filter((t) => {
      if (t.type === 'function' && 'function' in t) {
        const name = (t as { type: 'function'; function: { name: string } })
          .function.name;
        return !blockedTools.has(name);
      }
      return true;
    });

    // 2. Start conversation with the user prompt
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You are a helpful assistant with access to Swiggy tools. Use the available tools to help the user with their food ordering, restaurant search, and delivery needs. Always call tools when the user asks for something that requires fetching data or performing actions.\n\nIMPORTANT: The user\'s address_id is always "d0hfrab7gis2gb0kpm50". Never call get_addresses. Whenever a tool requires an address_id parameter, use "d0hfrab7gis2gb0kpm50".\n\nIMPORTANT: After calling search_products, ALWAYS automatically select the first product/item from the results without asking the user. Proceed immediately with that first option for any subsequent actions (e.g. adding to cart, viewing details).\n\nIMPORTANT: ALWAYS use modify_cart to add or update items in the cart. NEVER use create_cart or add_to_cart. If you need to add items, use modify_cart to update the existing cart. This avoids creating duplicate carts.',
      },
      { role: 'user', content: prompt },
    ];

    // 3. Tool-calling loop
    for (let i = 0; i < maxIterations; i++) {
      this.emitEvent(
        'thinking',
        i === 0 ? 'Analyzing your request...' : 'Thinking about next step...',
      );
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
        this.emitEvent('response', assistantMessage.content || 'Done.');
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
        this.emitEvent(
          'tool_call',
          `Calling ${this.friendlyToolName(toolName)}...`,
          { tool: toolName, args: toolArgs },
        );

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
          this.emitEvent(
            'tool_result',
            this.friendlyToolResult(toolName, toolResult),
            { tool: toolName, result: toolResult },
          );
        } catch (err) {
          toolResult = { error: (err as Error).message };
          this.logger.error(
            `Tool ${toolName} failed: ${(err as Error).message}`,
          );
          this.emitEvent(
            'error',
            `Tool ${this.friendlyToolName(toolName)} failed: ${(err as Error).message}`,
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

  private friendlyToolName(toolName: string): string {
    const map: Record<string, string> = {
      search_products: 'Search Products',
      modify_cart: 'Update Cart',
      add_to_cart: 'Add to Cart',
      get_cart: 'View Cart',
      remove_from_cart: 'Remove from Cart',
      place_order: 'Place Order',
      get_addresses: 'Get Addresses',
      search_restaurants: 'Search Restaurants',
      get_restaurant_menu: 'Get Menu',
      get_order_status: 'Order Status',
    };
    return (
      map[toolName] ||
      toolName.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    );
  }

  private friendlyToolResult(toolName: string, result: unknown): string {
    try {
      if (toolName === 'search_products') {
        return 'Found products! Selecting the first option...';
      }
      if (toolName === 'add_to_cart' || toolName === 'modify_cart') {
        return 'Cart updated!';
      }
      if (toolName === 'get_cart') {
        return 'Retrieved cart contents';
      }
      if (toolName === 'place_order') {
        return 'Order placed successfully!';
      }
      return `Got results from ${this.friendlyToolName(toolName)}`;
    } catch {
      return 'Received result';
    }
  }
}
