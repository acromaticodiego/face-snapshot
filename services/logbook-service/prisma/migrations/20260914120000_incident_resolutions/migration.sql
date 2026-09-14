-- Cerrar una incidencia SIN tocar el parte que la contiene.
--
-- Un parte firmado no se edita (ADR 0012), y las incidencias viven
-- dentro de uno. Marcar una como cerrada en su propia fila haria que el
-- documento dijera algo distinto de lo que decia al firmarse, que es
-- exactamente lo que un registro no puede hacer.
--
-- Mismo patron que `corrects_entry_id`: el hecho nuevo referencia al
-- anterior y los dos quedan. A cambio se puede responder «quien cerro
-- esto y cuando», que con un booleano en `incidents` se habria perdido.

CREATE TABLE IF NOT EXISTS "incident_resolutions" (
  "id"          UUID NOT NULL,
  "incident_id" UUID NOT NULL,

  "person_id"   UUID NOT NULL,
  "person_name" VARCHAR(120) NOT NULL,

  "note" VARCHAR(500),

  "resolved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "incident_resolutions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "incident_resolutions_incident_id_fkey" FOREIGN KEY ("incident_id")
    REFERENCES "incidents" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- UNA resolucion por incidencia, y lo sostiene la base de datos.
--
-- No es ceremonia: dos personas entrando al turno pueden pulsar el
-- boton en el mismo segundo. Sin esto quedarian dos resoluciones de la
-- misma cosa con autores distintos, y el servicio no tendria forma de
-- saber cual vale. Con esto, la segunda choca y el servicio lo trata
-- como exito, que es lo que es: el trabajo ya estaba hecho.
CREATE UNIQUE INDEX IF NOT EXISTS "incident_resolutions_incident_id_key"
  ON "incident_resolutions" ("incident_id");
