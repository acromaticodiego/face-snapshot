import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

/**
 * Datos iniciales del dominio de acceso.
 *
 * Sin esto el sistema arranca sin ninguna sede ni punto de acceso, y
 * ninguna verificación puede prosperar: no habría puerta que autorizar.
 *
 * Es idempotente —usa `upsert`— así que puede ejecutarse las veces que
 * haga falta sin duplicar nada.
 *
 *   npm run prisma:seed
 */

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.ACCESS_DATABASE_URL! }),
});

/** Genera las reglas de un horario de lunes a viernes. */
function weekdayRules(startHour: number, endHour: number) {
  return [1, 2, 3, 4, 5].map((weekday) => ({
    weekday,
    startMinute: startHour * 60,
    endMinute: endHour * 60,
  }));
}

async function main() {
  // ── Sede y topología ───────────────────────────────────────────
  const site = await prisma.site.upsert({
    where: { id: '11111111-1111-4111-8111-111111111111' },
    update: {},
    create: {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Sede Principal',
      timezone: 'America/Bogota',
      address: 'Medellín, Colombia',
    },
  });

  const offices = await prisma.zone.upsert({
    where: { siteId_name: { siteId: site.id, name: 'Oficinas' } },
    update: {},
    create: {
      siteId: site.id,
      name: 'Oficinas',
      description: 'Área general de trabajo',
    },
  });

  const lab = await prisma.zone.upsert({
    where: { siteId_name: { siteId: site.id, name: 'Laboratorio' } },
    update: {},
    create: {
      siteId: site.id,
      name: 'Laboratorio',
      description: 'Acceso restringido',
    },
  });

  // La clave del terminal es la que envía la tablet de la puerta.
  await prisma.accessPoint.upsert({
    where: { terminalKey: 'main-entrance' },
    update: {},
    create: {
      zoneId: offices.id,
      name: 'Entrada Principal',
      direction: 'BOTH',
      terminalKey: 'main-entrance',
    },
  });

  await prisma.accessPoint.upsert({
    where: { terminalKey: 'lab-door' },
    update: {},
    create: {
      zoneId: lab.id,
      name: 'Puerta Laboratorio',
      direction: 'BOTH',
      terminalKey: 'lab-door',
    },
  });

  // ── Horarios ───────────────────────────────────────────────────
  const officeSchedule = await prisma.schedule.upsert({
    where: { name: 'Horario de oficina' },
    update: {},
    create: {
      name: 'Horario de oficina',
      description: 'Lunes a viernes, 07:00 a 19:00',
      rules: { create: weekdayRules(7, 19) },
    },
  });

  const alwaysSchedule = await prisma.schedule.upsert({
    where: { name: '24/7' },
    update: {},
    create: {
      name: '24/7',
      description: 'Todos los días, sin restricción horaria',
      rules: {
        create: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
          weekday,
          startMinute: 0,
          endMinute: 24 * 60,
        })),
      },
    },
  });

  // ── Roles y permisos ───────────────────────────────────────────
  const employee = await prisma.role.upsert({
    where: { name: 'Empleado' },
    update: {},
    create: { name: 'Empleado', description: 'Personal de planta' },
  });

  const security = await prisma.role.upsert({
    where: { name: 'Seguridad' },
    update: {},
    create: { name: 'Seguridad', description: 'Vigilancia, acceso permanente' },
  });

  const contractor = await prisma.role.upsert({
    where: { name: 'Contratista' },
    update: {},
    create: { name: 'Contratista', description: 'Personal externo temporal' },
  });

  const permissions = [
    // Empleado: oficinas en horario laboral.
    { roleId: employee.id, zoneId: offices.id, scheduleId: officeSchedule.id },
    // Seguridad: todo, siempre. Es su trabajo.
    { roleId: security.id, zoneId: offices.id, scheduleId: alwaysSchedule.id },
    { roleId: security.id, zoneId: lab.id, scheduleId: alwaysSchedule.id },
    // Contratista: solo oficinas, y solo en horario laboral.
    // Nótese que NO tiene acceso al laboratorio: es el ejemplo de que
    // reconocer a alguien no implica dejarle pasar a todas partes.
    { roleId: contractor.id, zoneId: offices.id, scheduleId: officeSchedule.id },
  ];

  for (const permission of permissions) {
    await prisma.rolePermission.upsert({
      where: {
        roleId_zoneId_scheduleId: {
          roleId: permission.roleId,
          zoneId: permission.zoneId,
          scheduleId: permission.scheduleId,
        },
      },
      update: {},
      create: permission,
    });
  }

  console.log('Datos iniciales listos:');
  console.log(`  Sede            ${site.name} (${site.timezone})`);
  console.log(`  Zonas           ${offices.name}, ${lab.name}`);
  console.log('  Puntos          main-entrance, lab-door');
  console.log('  Roles           Empleado, Seguridad, Contratista');
  console.log('  Horarios        Horario de oficina, 24/7');
  console.log('');
  console.log('Asigna un rol a una persona para que pueda entrar:');
  console.log('  POST /api/v1/admin/persons/:id/roles');
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
