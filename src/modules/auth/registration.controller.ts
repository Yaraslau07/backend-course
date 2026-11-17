import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';

import { Public } from '@/core/authorization/route-access';
import { RateLimit } from '@/core/rate-limit/rate-limit.decorator';

import { RegisterDto } from './dto/register.dto';
import { RegistrationConfirmDto } from './dto/registration-confirm.dto';
import { RegistrationResendDto } from './dto/registration-resend.dto';
import { RegistrationService } from './registration.service';

@ApiTags('auth')
@Controller('auth/register')
export class RegistrationController {
  constructor(private readonly registration: RegistrationService) {}

  @Post()
  @Public()
  @RateLimit('registration_ip')
  @ApiOperation({ summary: 'Register with email and password (spec 1.0)' })
  @ApiResponse({
    status: 201,
    description: 'Active user created (confirmation off).',
  })
  @ApiResponse({
    status: 202,
    description: 'Pending; confirm with the code or link from the email.',
  })
  @ApiResponse({ status: 409, description: '`email_taken`' })
  async register(
    @Body() dto: RegisterDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<unknown> {
    const result = await this.registration.register(dto);
    void reply.status(result.status);
    return result.body;
  }

  @Post('confirm')
  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Confirm a registration with `attemptId` + `code`, or `token`',
  })
  confirm(@Body() dto: RegistrationConfirmDto): Promise<unknown> {
    return this.registration.confirm(dto);
  }

  @Post('resend')
  @Public()
  @RateLimit('registration_resend_ip')
  @HttpCode(202)
  @ApiOperation({
    summary: 'Send the confirmation email again (once per 60 s)',
  })
  resend(@Body() dto: RegistrationResendDto): Promise<unknown> {
    return this.registration.resend(dto);
  }
}
