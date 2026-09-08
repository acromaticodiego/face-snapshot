import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AccessLogsService } from './access-logs.service';

@ApiTags('access-logs')
@Controller('access-logs')
export class AccessLogsController {
  constructor(private readonly logs: AccessLogsService) {}

  @Get()
  @ApiOperation({ summary: 'Historial de intentos de acceso' })
  findAll(
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('granted') granted?: string,
  ) {
    return this.logs.findLogs({
      skip: skip ? Number(skip) : undefined,
      take: take ? Number(take) : undefined,
      onlyGranted:
        granted === undefined ? undefined : granted === 'true',
    });
  }
}
