-- Presencia y anti-passback.
--
-- POR QUE ESTA MIGRACION ESTA ESCRITA A MANO
-- ------------------------------------------
-- Igual que las anteriores: las migraciones de este proyecto no crean
-- el schema ni las extensiones, eso lo hace el script de
-- inicializacion de PostgreSQL como superusuario. Esa decision impide
-- que Prisma use su base de datos sombra para generar los diffs.
-- Ver .github/CONTRIBUTING.md.

-- ── Nuevo motivo de denegacion ───────────────────────────────────
--
-- No es un fallo de permisos: la persona tiene derecho a estar ahi,
-- pero el sistema ya la considera dentro.
ALTER TYPE "AccessReason" ADD VALUE IF NOT EXISTS 'ANTIPASSBACK_VIOLATION';

-- ── Tipos nuevos ─────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AntipassbackMode') THEN
    CREATE TYPE "AntipassbackMode" AS ENUM ('HARD', 'SOFT', 'OFF');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShiftEffect') THEN
    CREATE TYPE "ShiftEffect" AS ENUM ('WORK', 'BREAK', 'NEUTRAL');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'AccessAnomaly') THEN
    CREATE TYPE "AccessAnomaly" AS ENUM ('ANTIPASSBACK_SOFT', 'DUPLICATE_PASSAGE');
  END IF;
END
$$;

-- ── Configuracion por zona ───────────────────────────────────────
--
-- El modo por defecto es SOFT y no HARD a proposito. Al desplegar,
-- nadie ha "entrado" todavia segun el sistema, asi que la primera
-- salida de cada persona seria una violacion. Con HARD por defecto, el
-- estreno del anti-passback consistiria en dejar a la plantilla
-- encerrada.
ALTER TABLE "zones"
  ADD COLUMN IF NOT EXISTS "antipassback_mode" "AntipassbackMode" NOT NULL DEFAULT 'SOFT',
  ADD COLUMN IF NOT EXISTS "shift_effect"      "ShiftEffect"      NOT NULL DEFAULT 'WORK';

-- ── Anomalias en la auditoria ────────────────────────────────────
--
-- Columna aparte de `reason` porque responden a preguntas distintas:
-- `reason` dice por que se abrio o no la puerta; `anomaly`, que fue
-- raro aunque se abriera. Sin ella, una violacion en modo blando no
-- dejaria rastro.
ALTER TABLE "access_logs"
  ADD COLUMN IF NOT EXISTS "anomaly" "AccessAnomaly";

CREATE INDEX IF NOT EXISTS "access_logs_anomaly_created_at_idx"
  ON "access_logs" ("anomaly", "created_at")
  WHERE "anomaly" IS NOT NULL;

-- ── Presencia ────────────────────────────────────────────────────
--
-- Una fila por persona y zona. La clave primaria compuesta es
-- deliberada: la consulta del camino critico es exactamente "¿esta
-- esta persona dentro de esta zona?", y con esa clave se resuelve sin
-- tocar un indice secundario.
--
-- No hay clave foranea hacia `person_id`: esa tabla vive en face_svc,
-- que es otro servicio y otro schema. Misma regla que en el resto del
-- modelo.
CREATE TABLE IF NOT EXISTS "presence" (
  "person_id"            UUID NOT NULL,
  "zone_id"              UUID NOT NULL,
  "site_id"              UUID NOT NULL,
  "inside"               BOOLEAN NOT NULL DEFAULT false,
  "last_direction"       "PassageDirection" NOT NULL,
  "last_access_point_id" UUID,
  "last_passage_at"      TIMESTAMPTZ(6) NOT NULL,
  "updated_at"           TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "presence_pkey" PRIMARY KEY ("person_id", "zone_id")
);

-- Aforo por zona y por sede: las dos consultas del panel de operacion.
CREATE INDEX IF NOT EXISTS "presence_zone_id_inside_idx"
  ON "presence" ("zone_id", "inside");
CREATE INDEX IF NOT EXISTS "presence_site_id_inside_idx"
  ON "presence" ("site_id", "inside");

-- Si se elimina una zona, su presencia deja de significar nada.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'presence_zone_id_fkey'
  ) THEN
    ALTER TABLE "presence"
      ADD CONSTRAINT "presence_zone_id_fkey"
      FOREIGN KEY ("zone_id") REFERENCES "zones" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
