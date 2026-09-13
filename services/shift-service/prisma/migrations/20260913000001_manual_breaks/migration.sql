-- Descansos declarados por la persona.
--
-- No todo descanso cruza un lector: ir al bano, bajar a por un cafe o
-- comer en el propio puesto son interrupciones reales de la jornada
-- que ninguna puerta registra. Sin poder declararlas, la hoja de horas
-- contaria como trabajado todo lo que ocurriera dentro del edificio.
--
-- Escrita a mano por el mismo motivo que el resto: las migraciones de
-- este proyecto no crean el schema ni los roles.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ShiftEntryOrigin') THEN
    CREATE TYPE "ShiftEntryOrigin" AS ENUM ('ACCESS', 'MANUAL', 'SYSTEM');
  END IF;
END
$$;

-- El valor por defecto es ACCESS y no MANUAL a proposito: todas las
-- entradas que ya existen nacieron de un paso por una puerta, y
-- marcarlas de otro modo falsearia el historico.
ALTER TABLE "timeline_entries"
  ADD COLUMN IF NOT EXISTS "origin" "ShiftEntryOrigin" NOT NULL DEFAULT 'ACCESS',
  ADD COLUMN IF NOT EXISTS "note"   VARCHAR(80);

-- Las entradas que cerro el reconciliador no vienen de ninguna puerta.
-- Se reconocen porque no tienen evento de origen y acaban en FUERA.
UPDATE "timeline_entries"
   SET "origin" = 'SYSTEM'
 WHERE "source_event_id" IS NULL
   AND "to_state" = 'FUERA'
   AND "origin" = 'ACCESS';
