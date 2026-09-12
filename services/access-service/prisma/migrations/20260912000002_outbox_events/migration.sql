-- Outbox transaccional.
--
-- Escrita a mano por el mismo motivo que las anteriores: las
-- migraciones de este proyecto no crean el schema ni las extensiones.
-- Ver .github/CONTRIBUTING.md.

CREATE TABLE IF NOT EXISTS "outbox_events" (
  "id"           UUID NOT NULL,
  "type"         VARCHAR(80) NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "payload"      JSONB NOT NULL,
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMPTZ(6),
  "attempts"     INTEGER NOT NULL DEFAULT 0,
  "last_error"   VARCHAR(500),

  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

-- Indice PARCIAL sobre lo pendiente.
--
-- Es la consulta del relay -"dame los eventos sin publicar, en
-- orden"- y se ejecuta cada segundo. Con un indice completo, su coste
-- crecería con el historico entero; con el parcial, solo con la cola
-- pendiente, que en operacion normal son unas pocas filas aunque la
-- tabla tenga millones.
--
-- Prisma no sabe expresar indices parciales en el schema, asi que este
-- indice existe solo aqui. Es una de las razones por las que estas
-- migraciones se escriben a mano.
CREATE INDEX IF NOT EXISTS "outbox_events_pending_idx"
  ON "outbox_events" ("created_at")
  WHERE "published_at" IS NULL;

CREATE INDEX IF NOT EXISTS "outbox_events_created_at_idx"
  ON "outbox_events" ("created_at");

CREATE INDEX IF NOT EXISTS "outbox_events_aggregate_id_idx"
  ON "outbox_events" ("aggregate_id");
