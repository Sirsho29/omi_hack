import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { AiService } from './ai.service.js';
import { McpClientService } from './mcp-client.service.js';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);

  constructor(
    private readonly mcpClient: McpClientService,
    private readonly aiService: AiService,
  ) {}

  // ─── Health Check ──────────────────────────────────────────────
  @Get()
  getStatus() {
    return {
      status: 'ok',
      authenticated: this.mcpClient.isAuthenticated(),
    };
  }

  // ─── OAuth Flow ────────────────────────────────────────────────

  /**
   * GET /oauth/login
   * Redirects user to Swiggy's OAuth authorization page
   */
  @Get('oauth/login')
  oauthLogin(@Res() res: Response) {
    const url = this.mcpClient.getAuthorizationUrl();
    this.logger.log(`Redirecting to OAuth: ${url}`);
    res.redirect(url);
  }

  /**
   * GET /oauth/callback
   * Handles the OAuth callback, exchanges code for tokens,
   * then connects to the MCP server
   */
  @Get('oauth/callback')
  async oauthCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ) {
    if (error) {
      throw new HttpException(`OAuth error: ${error}`, HttpStatus.BAD_REQUEST);
    }
    if (!code || !state) {
      throw new HttpException(
        'Missing code or state parameter',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      // Exchange code for tokens
      await this.mcpClient.exchangeCodeForToken(code, state);
      // Connect to the MCP server
      await this.mcpClient.connect();

      this.logger.log('OAuth complete, MCP client connected');

      res.json({
        message: 'Authenticated and connected to Swiggy MCP server!',
        authenticated: true,
      });
    } catch (err) {
      this.logger.error(`OAuth callback failed: ${(err as Error).message}`);
      throw new HttpException(
        `Authentication failed: ${(err as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── MCP Tool Discovery ───────────────────────────────────────

  /**
   * GET /tools
   * Lists all available tools from the MCP server
   */
  @Get('tools')
  async listTools() {
    this.ensureAuthenticated();
    try {
      const tools = await this.aiService.getAvailableTools();
      return { tools, count: tools.length };
    } catch (err) {
      throw new HttpException(
        `Failed to list tools: ${(err as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── AI Prompt Endpoint ────────────────────────────────────────

  /**
   * POST /prompt
   * Send a natural language prompt. OpenAI will automatically
   * select and call the right MCP tools.
   *
   * Body: { "prompt": "Find me biryani restaurants nearby" }
   */
  @Post('prompt')
  async runPrompt(@Body() body: { prompt: string }) {
    this.ensureAuthenticated();

    if (!body.prompt) {
      throw new HttpException(
        'Missing "prompt" in request body',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.aiService.runPrompt(body.prompt);
      return result;
    } catch (err) {
      this.logger.error(`Prompt execution failed: ${(err as Error).message}`);
      throw new HttpException(
        `Prompt failed: ${(err as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Direct Tool Call ──────────────────────────────────────────

  /**
   * POST /tool/call
   * Call a specific MCP tool directly.
   *
   * Body: { "name": "tool_name", "args": { ... } }
   */
  @Post('tool/call')
  async callTool(
    @Body() body: { name: string; args?: Record<string, unknown> },
  ) {
    this.ensureAuthenticated();

    if (!body.name) {
      throw new HttpException(
        'Missing "name" in request body',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.mcpClient.callTool(body.name, body.args || {});
      return result;
    } catch (err) {
      throw new HttpException(
        `Tool call failed: ${(err as Error).message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────

  private ensureAuthenticated() {
    if (!this.mcpClient.isAuthenticated()) {
      throw new HttpException(
        'Not authenticated. Visit /oauth/login first.',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }
}
