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
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { AiService } from './ai.service.js';
import { McpClientService } from './mcp-client.service.js';

@Controller()
export class AppController {
  private readonly logger = new Logger(AppController.name);
  private readonly logDir = join(process.cwd(), 'logs');
  private readonly logFile = join(this.logDir, 'omi-webhook.log.jsonl');

  constructor(
    private readonly mcpClient: McpClientService,
    private readonly aiService: AiService,
  ) {
    // Ensure logs directory exists
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

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

  // ─── Omi Webhook ──────────────────────────────────────────────

  /**
   * POST /webhook/omi
   * Receives transcript data from Omi device.
   * Extracts the transcript text and feeds it to the AI service
   * which uses MCP tools to fulfill the user's intent (e.g. ordering food).
   */
  @Post('webhook/omi')
  async omiWebhook(@Body() body: Record<string, unknown>) {
    this.logger.log(
      `Omi webhook received: ${JSON.stringify(body).slice(0, 500)}`,
    );

    // Extract transcript text from Omi payload
    const transcript = this.extractTranscript(body);

    if (!transcript) {
      this.logger.warn('No transcript found in Omi webhook payload');
      this.writeLog({
        status: 'ignored',
        reason: 'no transcript',
        rawBody: body,
      });
      return { status: 'ignored', reason: 'no transcript' };
    }

    this.logger.log(`Processing Omi transcript: "${transcript.slice(0, 200)}"`);

    // If not authenticated, we can't process — return early
    if (!this.mcpClient.isAuthenticated()) {
      this.logger.warn(
        'MCP client not authenticated, cannot process transcript',
      );
      this.writeLog({
        status: 'error',
        reason: 'not authenticated',
        transcript,
      });
      return { status: 'error', reason: 'not authenticated' };
    }

    try {
      const result = await this.aiService.runPrompt(transcript);

      this.logger.log('═══════════════════════════════════════════════════');
      this.logger.log(`📝 TRANSCRIPT: ${transcript}`);
      this.logger.log(`🤖 AI RESPONSE: ${result.response}`);
      this.logger.log(`🔧 TOOLS CALLED: ${result.toolCalls.length}`);
      for (const tc of result.toolCalls) {
        this.logger.log(
          `   → ${tc.tool}(${JSON.stringify(tc.args).slice(0, 200)})`,
        );
        this.logger.log(
          `     Result: ${JSON.stringify(tc.result).slice(0, 300)}`,
        );
      }
      this.logger.log('═══════════════════════════════════════════════════');

      const logEntry = {
        status: 'processed',
        transcript,
        response: result.response,
        toolCalls: result.toolCalls,
      };
      this.writeLog(logEntry);

      return logEntry;
    } catch (err) {
      this.logger.error(
        `Omi webhook processing failed: ${(err as Error).message}`,
      );
      const errorEntry = {
        status: 'error',
        transcript,
        reason: (err as Error).message,
      };
      this.writeLog(errorEntry);
      return errorEntry;
    }
  }

  /**
   * Extract transcript text from various Omi webhook payload formats.
   */
  private extractTranscript(body: Record<string, unknown>): string | null {
    // Format 1: { transcript: "..." }
    if (typeof body.transcript === 'string' && body.transcript.trim()) {
      return body.transcript.trim();
    }

    // Format 2: { segments: [{ text: "..." }, ...] }
    if (Array.isArray(body.segments)) {
      const texts = (body.segments as Array<Record<string, unknown>>)
        .map((s) => (typeof s.text === 'string' ? s.text : ''))
        .filter(Boolean);
      if (texts.length > 0) return texts.join(' ').trim();
    }

    // Format 3: { text: "..." }
    if (typeof body.text === 'string' && body.text.trim()) {
      return body.text.trim();
    }

    // Format 4: { data: { transcript: "..." } } or { data: { text: "..." } }
    if (body.data && typeof body.data === 'object') {
      const data = body.data as Record<string, unknown>;
      if (typeof data.transcript === 'string' && data.transcript.trim()) {
        return data.transcript.trim();
      }
      if (typeof data.text === 'string' && data.text.trim()) {
        return data.text.trim();
      }
    }

    // Format 5: { message: "..." }
    if (typeof body.message === 'string' && body.message.trim()) {
      return body.message.trim();
    }

    return null;
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

  /**
   * Append a JSON log entry to the JSONL log file
   */
  private writeLog(entry: Record<string, unknown>) {
    try {
      const logLine =
        JSON.stringify({
          timestamp: new Date().toISOString(),
          ...entry,
        }) + '\n';
      appendFileSync(this.logFile, logLine, 'utf-8');
    } catch (err) {
      this.logger.error(`Failed to write log: ${(err as Error).message}`);
    }
  }
}
