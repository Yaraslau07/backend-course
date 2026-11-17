import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '@/core/authorization/route-access';
import { RateLimit } from '@/core/rate-limit/rate-limit.decorator';

import { AuthCookies, REFRESH_COOKIE } from './auth-cookies';
import { LoginDto } from './dto/login.dto';
import { LoginConfirmDto } from './dto/login-confirm.dto';
import { LoginResendDto } from './dto/login-resend.dto';
import { LoginService } from './login.service';
import { SessionService } from './session.service';

/**
 * Spec 1.2. Every route is public: they run before there is a session. CSRF still applies to all
 * of them (the route guard checks public writes). Tokens go out only as HttpOnly cookies.
 */
@ApiTags('auth')
@Controller('auth')
export class LoginController {
  constructor(
    private readonly login: LoginService,
    private readonly sessions: SessionService,
    private readonly cookies: AuthCookies,
  ) {}

  @Post('login')
  @Public()
  @RateLimit('login_ip')
  @ApiOperation({ summary: 'Sign in with email and password (spec 1.2)' })
  @ApiNoContentResponse({
    description: 'Signed in: access and refresh cookies are set.',
  })
  @ApiResponse({
    status: 202,
    description: 'Confirmation required; finish with the code or link.',
  })
  @ApiResponse({ status: 401, description: '`invalid_credentials`' })
  @ApiResponse({
    status: 429,
    description: 'Rate limit, or a new email within 60 s',
  })
  async signIn(
    @Body() dto: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const result = await this.login.login(dto, request.ip);
    if (result.kind === 'challenge') {
      void reply.status(202);
      return result.body;
    }
    this.cookies.set(reply, result.pair);
    void reply.status(204);
    return undefined;
  }

  @Post('login/confirm')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Finish signing in with `attemptId` + `code`, or `token`',
  })
  @ApiNoContentResponse({ description: 'Signed in: both cookies are set.' })
  async confirm(
    @Body() dto: LoginConfirmDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    this.cookies.set(reply, await this.login.confirm(dto));
  }

  @Post('login/resend')
  @Public()
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send the sign-in code or link again (once per 60 s)',
  })
  resend(@Body() dto: LoginResendDto): Promise<unknown> {
    return this.login.resend(dto);
  }

  @Post('refresh')
  @Public()
  @RateLimit('refresh_ip')
  @HttpCode(204)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({
    summary: 'New access and refresh cookies from the refresh cookie',
  })
  @ApiNoContentResponse({ description: 'Both cookies are replaced.' })
  @ApiResponse({ status: 401, description: '`invalid_session`' })
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const pair = await this.sessions.refresh(
      this.cookies.read(request, REFRESH_COOKIE),
    );
    this.cookies.set(reply, pair);
  }

  @Post('logout')
  @Public()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Clear both cookies (always 204, with or without a session)',
  })
  logout(@Res({ passthrough: true }) reply: FastifyReply): void {
    this.cookies.clear(reply);
    this.sessions.logout();
  }
}
