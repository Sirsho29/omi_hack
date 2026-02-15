import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Injectable, Logger } from '@nestjs/common';
import crypto from 'node:crypto';

const MCP_BASE_URL = 'https://mcp.swiggy.com';
const MCP_ENDPOINT = `${MCP_BASE_URL}/im`;
const AUTH_AUTHORIZE_URL = `${MCP_BASE_URL}/auth/authorize`;
const AUTH_TOKEN_URL = `${MCP_BASE_URL}/auth/token`;
const CLIENT_ID = 'swiggy-mcp';
const REDIRECT_URI = 'http://localhost:3000/oauth/callback';
const SCOPES = 'mcp:tools mcp:resources mcp:prompts';

interface TokenData {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  expires_at?: number;
}

interface PendingAuth {
  codeVerifier: string;
  state: string;
}

@Injectable()
export class McpClientService {
  private readonly logger = new Logger(McpClientService.name);
  private client: Client | null = null;
  private tokenData: TokenData | null = null;
  private pendingAuth: PendingAuth | null = null;

  /**
   * Generate PKCE code verifier and challenge
   */
  private generatePKCE(): { codeVerifier: string; codeChallenge: string } {
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');
    return { codeVerifier, codeChallenge };
  }

  /**
   * Step 1: Get the authorization URL to redirect the user to
   */
  getAuthorizationUrl(): string {
    const { codeVerifier, codeChallenge } = this.generatePKCE();
    const state = crypto.randomBytes(16).toString('hex');

    this.pendingAuth = { codeVerifier, state };

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `${AUTH_AUTHORIZE_URL}?${params.toString()}`;
  }

  /**
   * Step 2: Exchange the authorization code for tokens
   */
  async exchangeCodeForToken(code: string, state: string): Promise<void> {
    if (!this.pendingAuth) {
      throw new Error('No pending authorization. Start the OAuth flow first.');
    }
    if (this.pendingAuth.state !== state) {
      throw new Error('State mismatch. Possible CSRF attack.');
    }

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: this.pendingAuth.codeVerifier,
    });

    const response = await fetch(AUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Token exchange failed: ${response.status} ${errText}`);
    }

    this.tokenData = (await response.json()) as TokenData;
    if (this.tokenData.expires_in) {
      this.tokenData.expires_at = Date.now() + this.tokenData.expires_in * 1000;
    }
    this.pendingAuth = null;
    this.logger.log('OAuth tokens acquired successfully');
  }

  /**
   * Refresh the access token if we have a refresh token
   */
  async refreshAccessToken(): Promise<void> {
    if (!this.tokenData?.refresh_token) {
      throw new Error('No refresh token available. Re-authorize.');
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.tokenData.refresh_token,
      client_id: CLIENT_ID,
    });

    const response = await fetch(AUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!response.ok) {
      this.tokenData = null;
      throw new Error('Token refresh failed. Re-authorize.');
    }

    this.tokenData = (await response.json()) as TokenData;
    if (this.tokenData.expires_in) {
      this.tokenData.expires_at = Date.now() + this.tokenData.expires_in * 1000;
    }
    this.logger.log('Tokens refreshed successfully');
  }

  /**
   * Get a valid access token, refreshing if needed
   */
  private async getValidToken(): Promise<string> {
    if (!this.tokenData) {
      throw new Error('Not authenticated. Complete OAuth flow first.');
    }
    // refresh if token is about to expire (within 60 seconds)
    if (
      this.tokenData.expires_at &&
      Date.now() > this.tokenData.expires_at - 60_000
    ) {
      await this.refreshAccessToken();
    }
    return this.tokenData.access_token;
  }

  /**
   * Connect to the MCP server using the authenticated token.
   * Tries Streamable HTTP first, falls back to SSE.
   */
  async connect(): Promise<void> {
    const token = await this.getValidToken();

    this.client = new Client({
      name: 'omi-hack-client',
      version: '1.0.0',
    });

    const headers = {
      Authorization: `Bearer ${token}`,
    };

    try {
      // Try Streamable HTTP first (MCP 2025+)
      const transport = new StreamableHTTPClientTransport(
        new URL(MCP_ENDPOINT),
        { requestInit: { headers } },
      );
      await this.client.connect(transport);
      this.logger.log('Connected via Streamable HTTP transport');
    } catch (err) {
      this.logger.warn(
        'Streamable HTTP failed, falling back to SSE transport...',
      );
      // Fall back to SSE
      try {
        this.client = new Client({
          name: 'omi-hack-client',
          version: '1.0.0',
        });
        const sseTransport = new SSEClientTransport(new URL(MCP_ENDPOINT), {
          requestInit: { headers },
        });
        await this.client.connect(sseTransport);
        this.logger.log('Connected via SSE transport');
      } catch (sseErr) {
        this.client = null;
        throw new Error(
          `Failed to connect to MCP server: ${(sseErr as Error).message}`,
        );
      }
    }
  }

  /**
   * List all available tools from the MCP server
   */
  async listTools() {
    if (!this.client) {
      await this.connect();
    }
    const result = await this.client!.listTools();
    return result.tools;
  }

  /**
   * Call a specific tool on the MCP server
   */
  async callTool(name: string, args: Record<string, unknown>) {
    if (!this.client) {
      await this.connect();
    }
    this.logger.log(
      `Calling MCP tool: ${name} with args: ${JSON.stringify(args)}`,
    );
    const result = await this.client!.callTool({ name, arguments: args });
    return result;
  }

  /**
   * Check if the client is authenticated
   */
  isAuthenticated(): boolean {
    return this.tokenData !== null;
  }

  /**
   * Disconnect the client
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
