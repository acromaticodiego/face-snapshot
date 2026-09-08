-- Dominio de autorización: sedes, zonas, puntos de acceso, roles,
-- horarios y permisos.
--
-- POR QUE ESTA MIGRACION ESTA ESCRITA A MANO
-- ------------------------------------------
-- Las migraciones de este proyecto no crean el schema ni las
-- extensiones: eso lo hace el script de inicializacion de PostgreSQL,
-- que corre como superusuario, porque un rol de aplicacion no debe
-- poder crear schemas.
--
-- Esa decision (correcta para produccion) impide que Prisma reproduzca
-- las migraciones en su base de datos "sombra", que es como genera los
-- diffs automaticamente. El precio es escribirlas a mano; la
-- contrapartida es que ningun servicio tiene privilegios de mas.

-- ── Nuevos motivos de denegacion ─────────────────────────────────
--
-- Se distinguen de los de identificacion a proposito: "no te reconozco"
-- y "te reconozco pero no puedes pasar" son incidentes distintos para
-- quien opera el sistema.
ALTER TYPE "AccessReason" ADD VALUE IF NOT EXISTS 'NO_ROLE_ASSIGNED';
ALTER TYPE "AccessReason" ADD VALUE IF NOT EXISTS 'NO_PERMISSION_FOR_ZONE';
ALTER TYPE "AccessReason" ADD VALUE IF NOT EXISTS 'OUTSIDE_SCHEDULE';
ALTER TYPE "AccessReason" ADD VALUE IF NOT EXISTS 'ASSIGNMENT_EXPIRED';
ALTER TYPE "AccessReason" ADD VALUE IF NOT EXISTS 'ACCESS_POINT_DISABLED';

-- ── Direccion de paso ────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PassageDirection') THEN
    CREATE TYPE "PassageDirection" AS ENUM ('IN', 'OUT', 'BOTH');
  END IF;
END
$$;

-- ── Topologia fisica: sede -> zona -> punto de acceso ────────────

CREATE TABLE IF NOT EXISTS "sites" (
  "id"         UUID NOT NULL,
  "name"       VARCHAR(120) NOT NULL,
  -- Zona horaria IANA. Los horarios se evaluan en la hora LOCAL de la
  -- sede: con sedes en husos distintos, evaluar en UTC abriria las
  -- puertas a la hora equivocada.
  "timezone"   VARCHAR(64) NOT NULL DEFAULT 'America/Bogota',
  "address"    VARCHAR(200),
  "is_active"  BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "zones" (
  "id"          UUID NOT NULL,
  "site_id"     UUID NOT NULL,
  "name"        VARCHAR(120) NOT NULL,
  "description" VARCHAR(255),
  "is_active"   BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "zones_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "access_points" (
  "id"        UUID NOT NULL,
  "zone_id"   UUID NOT NULL,
  "name"      VARCHAR(120) NOT NULL,
  "direction" "PassageDirection" NOT NULL DEFAULT 'BOTH',
  -- Clave que identifica al terminal fisico. La envia el terminal en
  -- cada peticion; NO la elige quien entra. Si la escogiera el usuario,
  -- bastaria con decir que esta en una puerta a la que si tiene acceso.
  "terminal_key" VARCHAR(64) NOT NULL,
  "is_active"    BOOLEAN NOT NULL DEFAULT true,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"   TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "access_points_pkey" PRIMARY KEY ("id")
);

-- ── Autorizacion ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "roles" (
  "id"          UUID NOT NULL,
  "name"        VARCHAR(80) NOT NULL,
  "description" VARCHAR(255),
  "is_active"   BOOLEAN NOT NULL DEFAULT true,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "schedules" (
  "id"          UUID NOT NULL,
  "name"        VARCHAR(80) NOT NULL,
  "description" VARCHAR(255),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"  TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "schedule_rules" (
  "id"          UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  -- 0 = domingo ... 6 = sabado
  "weekday"     SMALLINT NOT NULL,
  -- Minutos desde medianoche, hora local de la sede. Se guardan como
  -- enteros y no como `time` para poder expresar franjas que cruzan la
  -- medianoche: 22:00-06:00 es start=1320, end=1800.
  "start_minute" INTEGER NOT NULL,
  "end_minute"   INTEGER NOT NULL,

  CONSTRAINT "schedule_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "role_permissions" (
  "id"          UUID NOT NULL,
  "role_id"     UUID NOT NULL,
  "zone_id"     UUID NOT NULL,
  "schedule_id" UUID NOT NULL,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- `person_id` referencia a face_svc.persons SIN clave foranea: son
-- servicios distintos, cada uno dueño de su schema.
CREATE TABLE IF NOT EXISTS "person_roles" (
  "id"          UUID NOT NULL,
  "person_id"   UUID NOT NULL,
  "role_id"     UUID NOT NULL,
  "valid_from"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "valid_until" TIMESTAMPTZ(6),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "person_roles_pkey" PRIMARY KEY ("id")
);

-- ── Indices y unicidad ───────────────────────────────────────────

CREATE UNIQUE INDEX IF NOT EXISTS "zones_site_id_name_key" ON "zones"("site_id", "name");
CREATE INDEX IF NOT EXISTS "zones_site_id_idx" ON "zones"("site_id");

CREATE UNIQUE INDEX IF NOT EXISTS "access_points_terminal_key_key" ON "access_points"("terminal_key");
CREATE INDEX IF NOT EXISTS "access_points_zone_id_idx" ON "access_points"("zone_id");

CREATE UNIQUE INDEX IF NOT EXISTS "roles_name_key" ON "roles"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "schedules_name_key" ON "schedules"("name");
CREATE INDEX IF NOT EXISTS "schedule_rules_schedule_id_idx" ON "schedule_rules"("schedule_id");

CREATE UNIQUE INDEX IF NOT EXISTS "role_permissions_role_id_zone_id_schedule_id_key"
  ON "role_permissions"("role_id", "zone_id", "schedule_id");
CREATE INDEX IF NOT EXISTS "role_permissions_role_id_idx" ON "role_permissions"("role_id");
CREATE INDEX IF NOT EXISTS "role_permissions_zone_id_idx" ON "role_permissions"("zone_id");

CREATE UNIQUE INDEX IF NOT EXISTS "person_roles_person_id_role_id_key"
  ON "person_roles"("person_id", "role_id");
CREATE INDEX IF NOT EXISTS "person_roles_person_id_idx" ON "person_roles"("person_id");

-- ── Claves foraneas ──────────────────────────────────────────────

ALTER TABLE "zones"
  ADD CONSTRAINT "zones_site_id_fkey" FOREIGN KEY ("site_id")
  REFERENCES "sites"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "access_points"
  ADD CONSTRAINT "access_points_zone_id_fkey" FOREIGN KEY ("zone_id")
  REFERENCES "zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "schedule_rules"
  ADD CONSTRAINT "schedule_rules_schedule_id_fkey" FOREIGN KEY ("schedule_id")
  REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id")
  REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_zone_id_fkey" FOREIGN KEY ("zone_id")
  REFERENCES "zones"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Restrict y no Cascade: borrar un horario que sigue concediendo
-- accesos debe fallar, no dejar permisos huerfanos en silencio.
ALTER TABLE "role_permissions"
  ADD CONSTRAINT "role_permissions_schedule_id_fkey" FOREIGN KEY ("schedule_id")
  REFERENCES "schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "person_roles"
  ADD CONSTRAINT "person_roles_role_id_fkey" FOREIGN KEY ("role_id")
  REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Auditoria: contexto fisico del intento ───────────────────────
--
-- Sin clave foranea a proposito: si mañana se elimina un punto de
-- acceso, el asiento historico debe seguir diciendo por donde se
-- intento entrar.
ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "site_id" UUID;
ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "site_name" VARCHAR(120);
ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "zone_id" UUID;
ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "zone_name" VARCHAR(120);
ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "access_point_id" UUID;
ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "access_point_name" VARCHAR(120);
ALTER TABLE "access_logs" ADD COLUMN IF NOT EXISTS "direction" "PassageDirection";

CREATE INDEX IF NOT EXISTS "access_logs_zone_id_created_at_idx"
  ON "access_logs"("zone_id", "created_at");
