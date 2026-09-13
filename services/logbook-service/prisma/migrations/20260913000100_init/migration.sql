-- Bitacora de relevo de turno: partes firmados e incidencias.
--
-- POR QUE ESTA MIGRACION ESTA ESCRITA A MANO
-- ------------------------------------------
-- Igual que las de los demas servicios: las migraciones de este
-- proyecto no crean el schema ni los roles, eso lo hace el script de
-- inicializacion de PostgreSQL como superusuario, porque un rol de
-- aplicacion no debe poder crear schemas. Ver .github/CONTRIBUTING.md.
--
-- El schema logbook_svc y el rol logbook_svc_user los crea
-- infrastructure/postgres/init/03-logbook.sql. Si la base de datos ya
-- existia antes de esta fase, aplicalo primero:
--     node scripts/apply-logbook-schema.mjs

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'HandoverSource') THEN
    CREATE TYPE "HandoverSource" AS ENUM ('DICTADO', 'ESCRITO');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncidentOrigin') THEN
    CREATE TYPE "IncidentOrigin" AS ENUM (
      'PROPUESTA_ACEPTADA', 'PROPUESTA_EDITADA', 'ANADIDA_POR_PERSONA'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncidentCategory') THEN
    CREATE TYPE "IncidentCategory" AS ENUM (
      'ACCESO', 'ALARMA', 'MANTENIMIENTO', 'SEGURIDAD', 'OTRO'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'IncidentSeverity') THEN
    CREATE TYPE "IncidentSeverity" AS ENUM ('BAJA', 'MEDIA', 'ALTA');
  END IF;
END
$$;

-- ── Partes firmados ───────────────────────────────────────────────
--
-- No hay columna de "borrador" ni de "estado": lo que entra aqui ya
-- esta firmado. La revision ocurre antes, en el cliente, sobre la
-- propuesta que devuelve el Voice Service.
CREATE TABLE IF NOT EXISTS "handover_entries" (
  "id"          UUID NOT NULL,
  "person_id"   UUID NOT NULL,
  "person_name" VARCHAR(120) NOT NULL,
  "site_id"     UUID NOT NULL,
  "site_name"   VARCHAR(120),

  -- Hora LOCAL de la sede, misma convencion que shift_svc: un turno de
  -- noche que empieza el lunes a las 22:00 es el parte del lunes. Con
  -- otra convencion, cruzar un parte con su jornada daria dias
  -- distintos.
  "business_date" DATE NOT NULL,

  -- Periodo que el parte declara cubrir, declarado por quien firma.
  "covers_from" TIMESTAMPTZ(6) NOT NULL,
  "covers_to"   TIMESTAMPTZ(6) NOT NULL,

  "source" "HandoverSource" NOT NULL,

  -- La transcripcion se guarda ADEMAS del resumen, no en vez de el: la
  -- estructura es una interpretacion y el texto es lo que se dijo.
  "transcript" TEXT,
  "summary"    TEXT NOT NULL,

  -- Procedencia: que modelos intervinieron, si intervino alguno.
  "transcription_model" VARCHAR(60),
  "structuring_model"   VARCHAR(60),

  -- Los accesos de la franja, CONGELADOS al firmar. Nulo si el Access
  -- Service no respondio: se prefiere un parte sin cruce a no tener
  -- parte.
  "access_snapshot" JSONB,

  "corrects_entry_id" UUID,

  "signed_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "handover_entries_pkey" PRIMARY KEY ("id"),

  -- El intervalo tiene que tener sentido. Se impone en la base de
  -- datos y no solo en el servicio porque es una invariante del dato,
  -- no una regla de presentacion: un parte que termina antes de
  -- empezar no significa nada.
  CONSTRAINT "handover_entries_covers_ordenado" CHECK ("covers_to" > "covers_from")
);

CREATE INDEX IF NOT EXISTS "handover_entries_person_id_business_date_idx"
  ON "handover_entries" ("person_id", "business_date");
CREATE INDEX IF NOT EXISTS "handover_entries_site_id_business_date_idx"
  ON "handover_entries" ("site_id", "business_date");
CREATE INDEX IF NOT EXISTS "handover_entries_covers_from_idx"
  ON "handover_entries" ("covers_from");

-- ── Incidencias ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "incidents" (
  "id"       UUID NOT NULL,
  "entry_id" UUID NOT NULL,

  "title"    VARCHAR(160) NOT NULL,
  "category" "IncidentCategory" NOT NULL,
  "severity" "IncidentSeverity" NOT NULL,

  -- La hora tal y como se dijo. Sin normalizar: convertir "sobre las
  -- tres" en 03:00:00 inventa una precision que nadie declaro.
  "mentioned_time" VARCHAR(60),

  "requires_follow_up" BOOLEAN NOT NULL DEFAULT FALSE,

  "origin" "IncidentOrigin" NOT NULL,

  "quote"          TEXT,
  "quote_verified" BOOLEAN NOT NULL DEFAULT FALSE,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "incidents_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "incidents_entry_id_fkey" FOREIGN KEY ("entry_id")
    REFERENCES "handover_entries" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "incidents_entry_id_idx" ON "incidents" ("entry_id");

-- Indice PARCIAL, y no sobre la columna entera.
--
-- La consulta que importa es "que queda pendiente para el turno que
-- entra", y solo mira las que estan a TRUE. Indexar tambien las falsas
-- -que son la mayoria- haria el indice varias veces mas grande sin que
-- nadie lo usara nunca para buscarlas.
--
-- Prisma no sabe expresar indices parciales, asi que este vive solo
-- aqui, igual que los tres de access_svc y shift_svc.
CREATE INDEX IF NOT EXISTS "incidents_pendientes_idx"
  ON "incidents" ("entry_id")
  WHERE "requires_follow_up" = TRUE;
