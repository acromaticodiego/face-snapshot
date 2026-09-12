-- Jornada laboral: estados de turno y linea de tiempo.
--
-- POR QUE ESTA MIGRACION ESTA ESCRITA A MANO
-- ------------------------------------------
-- Igual que las de los demas servicios: las migraciones de este
-- proyecto no crean el schema ni los roles, eso lo hace el script de
-- inicializacion de PostgreSQL como superusuario, porque un rol de
-- aplicacion no debe poder crear schemas. Ver .github/CONTRIBUTING.md.
--
-- El schema shift_svc y el rol shift_svc_user los crea
-- infrastructure/postgres/init/02-shift.sql. Si la base de datos ya
-- existia antes de esta fase, aplicalo primero:
--     node scripts/apply-shift-schema.mjs

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShiftState') THEN
    CREATE TYPE "ShiftState" AS ENUM (
      'FUERA', 'EN_TURNO', 'EN_DESCANSO', 'EN_PAUSA'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShiftClosedBy') THEN
    CREATE TYPE "ShiftClosedBy" AS ENUM ('TIMEOUT', 'STALE');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "work_days" (
  "id"          UUID NOT NULL,
  "person_id"   UUID NOT NULL,
  "person_name" VARCHAR(120) NOT NULL,
  "site_id"     UUID NOT NULL,
  "site_name"   VARCHAR(120) NOT NULL,

  -- Dia al que se imputa la jornada, en hora LOCAL de la sede. Se fija
  -- al abrirla: un turno de noche que empieza el lunes a las 22:00 es
  -- la jornada del lunes, y contarla en el martes descuadraria las dos.
  "business_date" DATE NOT NULL,

  "state"       "ShiftState" NOT NULL,
  "state_since" TIMESTAMPTZ(6) NOT NULL,

  "started_at" TIMESTAMPTZ(6) NOT NULL,
  "ended_at"   TIMESTAMPTZ(6),
  "closed_by"  "ShiftClosedBy",

  -- En SEGUNDOS y no en minutos: el tiempo se suma tramo a tramo en
  -- cada transicion, y redondeando a minutos cada vez una jornada con
  -- varias idas y venidas a la cafeteria perderia varios minutos por
  -- el camino. Son horas que se le pagan a alguien.
  "worked_seconds" INTEGER NOT NULL DEFAULT 0,
  "break_seconds"  INTEGER NOT NULL DEFAULT 0,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "work_days_pkey" PRIMARY KEY ("id")
);

-- UNA SOLA JORNADA ABIERTA POR PERSONA.
--
-- Es la invariante que sostiene todo el servicio: si hubiera dos, cada
-- evento actualizaria una cualquiera de las dos y las horas dejarian de
-- significar nada. Se impone con un indice unico PARCIAL y no con
-- codigo, porque el codigo se salta con dos procesos concurrentes y una
-- restriccion de la base de datos no.
--
-- Es tambien la razon de que las jornadas cerradas no estorben: al ser
-- parcial, el indice solo contiene las abiertas.
CREATE UNIQUE INDEX IF NOT EXISTS "work_days_one_open_per_person_idx"
  ON "work_days" ("person_id")
  WHERE "ended_at" IS NULL;

CREATE INDEX IF NOT EXISTS "work_days_person_id_business_date_idx"
  ON "work_days" ("person_id", "business_date");
CREATE INDEX IF NOT EXISTS "work_days_site_id_business_date_idx"
  ON "work_days" ("site_id", "business_date");

CREATE TABLE IF NOT EXISTS "timeline_entries" (
  "id"          UUID NOT NULL,
  "work_day_id" UUID,

  -- Clave de idempotencia del consumidor. La entrega por el bus es "al
  -- menos una vez": un evento puede llegar repetido tras un reinicio, y
  -- sin esta restriccion la persona acabaria con la entrada duplicada y
  -- las horas contadas dos veces.
  --
  -- Nula en las entradas que no nacen de un acceso, como el cierre por
  -- tiempo, que las genera este mismo servicio.
  "source_event_id" UUID,

  "person_id" UUID NOT NULL,
  "at"        TIMESTAMPTZ(6) NOT NULL,

  "from_state" "ShiftState" NOT NULL,
  "to_state"   "ShiftState" NOT NULL,

  "direction"         VARCHAR(3),
  "zone_id"           UUID,
  "zone_name"         VARCHAR(120),
  "access_point_name" VARCHAR(120),

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "timeline_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "timeline_entries_source_event_id_key"
  ON "timeline_entries" ("source_event_id");

CREATE INDEX IF NOT EXISTS "timeline_entries_person_id_at_idx"
  ON "timeline_entries" ("person_id", "at");
CREATE INDEX IF NOT EXISTS "timeline_entries_work_day_id_idx"
  ON "timeline_entries" ("work_day_id");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'timeline_entries_work_day_id_fkey'
  ) THEN
    ALTER TABLE "timeline_entries"
      ADD CONSTRAINT "timeline_entries_work_day_id_fkey"
      FOREIGN KEY ("work_day_id") REFERENCES "work_days" ("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
