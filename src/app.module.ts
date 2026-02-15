import { Module } from '@nestjs/common';
import { AiService } from './ai.service.js';
import { AppController } from './app.controller.js';
import { McpClientService } from './mcp-client.service.js';

@Module({
  imports: [],
  controllers: [AppController],
  providers: [McpClientService, AiService],
})
export class AppModule {}
