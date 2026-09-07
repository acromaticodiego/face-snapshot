import { Body, Controller, Post, UsePipes } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';

import { ZodValidationPipe } from '../common/zod-validation.pipe';
import { AdminAuthService } from './admin-auth.service';

const LoginSchema = z.object({
  email: z.string().trim().email().max(160),
  password: z.string().min(1).max(256),
});

@ApiTags('admin-auth')
@Controller('admin/auth')
export class AdminAuthController {
  constructor(private readonly auth: AdminAuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'Inicia sesión como administrador' })
  @ApiResponse({ status: 401, description: 'Credenciales inválidas' })
  /**
   * Límite agresivo, muy por debajo del resto de endpoints.
   *
   * El bloqueo por cuenta (5 fallos → 15 minutos) frena el ataque contra
   * un usuario concreto; este límite por IP frena el barrido de muchos
   * usuarios distintos desde el mismo origen. Hacen falta los dos.
   */
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @UsePipes(new ZodValidationPipe(LoginSchema))
  login(@Body() body: z.infer<typeof LoginSchema>) {
    return this.auth.login(body.email, body.password);
  }
}
