import { Injectable, Logger } from '@nestjs/common';

import { evaluatePolicy } from './policy.engine';
import {
  PolicyRepository,
  type AccessPointContext,
} from './policy.repository';
import type { PolicyResult } from './policy.types';

/**
 * Orquesta la autorización: carga los datos y llama al motor.
 *
 * La separación importa. Este servicio hace E/S y puede fallar por red
 * o por base de datos; el motor no falla nunca porque no habla con
 * nadie. Cuando algo va mal en producción, saber en cuál de las dos
 * capas ocurrió acorta mucho la investigación.
 */
@Injectable()
export class PolicyService {
  private readonly logger = new Logger(PolicyService.name);

  constructor(private readonly repository: PolicyRepository) {}

  resolveAccessPoint(terminalKey: string): Promise<AccessPointContext | null> {
    return this.repository.findAccessPointByTerminalKey(terminalKey);
  }

  async authorize(
    personId: string,
    point: AccessPointContext,
    now = new Date(),
  ): Promise<PolicyResult> {
    const assignments = await this.repository.findAssignments(personId);

    // Sin roles no hace falta consultar permisos: el motor ya va a
    // denegar, y evitamos una consulta a la base de datos por cada
    // frame de alguien que no tiene acceso.
    const permissions =
      assignments.length === 0
        ? []
        : await this.repository.findPermissions(
            assignments.map((assignment) => assignment.roleId),
            point.zoneId,
          );

    const result = evaluatePolicy({
      assignments,
      permissions,
      zoneId: point.zoneId,
      accessPointActive: point.accessPointActive,
      zoneActive: point.zoneActive,
      now,
      timezone: point.timezone,
    });

    if (!result.allowed) {
      // Solo metadatos: ni rostros ni vectores.
      this.logger.log(
        `Autorización denegada en ${point.siteName}/${point.zoneName}: ${result.reason}`,
      );
    }

    return result;
  }
}
