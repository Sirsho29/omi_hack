import { Controller, Get, Post, Req } from '@nestjs/common';
import { AppService } from './app.service';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('')
  getHello(): string {
    console.log('HELLO');
    return this.appService.getHello();
  }

  @Post('test')
  getTest(@Req() request: any): string {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    console.log('Request received:', request.body);
    return this.appService.getHello();
  }
}
