import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { AccessServiceClient } from '../proxy/service-clients';
import { AdminAuthGuard } from './admin-auth.guard';

@ApiTags('admin/access-logs')
@ApiBearerAuth()
@UseGuards(AdminAuthGuard)
@Controller('admin/access-logs')
export class AdminLogsController {
  constructor(private readonly access: AccessServiceClient) {}

  @Get()
  @ApiOperation({ summary: 'Historial de intentos de acceso' })
  list(
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('granted') granted?: string,
  ) {
    return this.access.listLogs({ skip, take, granted });
  }
}
