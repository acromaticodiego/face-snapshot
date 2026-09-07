import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AccessServiceClient } from '../proxy/service-clients';

@ApiTags('admin/access-logs')
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
