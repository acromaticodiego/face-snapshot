-- ══════════════════════════════════════════════════════════════════
--  El contexto de traza viaja CON el evento
--
--  El problema que resuelve: entre que se concede un acceso y que el
--  relay publica el evento pasa hasta un segundo, y son dos procesos
--  distintos. Sin guardar el contexto de traza en la propia fila, el
--  tramo asincrono aparece como una traza suelta y huerfana, y lo que
--  se quiere ver es UNA traza que vaya del frame hasta la transicion
--  de turno, cruzando el bus por el medio.
--
--  Se escribe en la MISMA transaccion que el evento, que es el unico
--  momento en el que el contexto de la peticion original sigue vivo.
--
--  Por que texto y no jsonb: lo que se guarda es una cabecera
--  `traceparent` del estandar W3C Trace Context, que es una cadena de
--  55 caracteres con formato fijo. Guardarla como json seria envolver
--  una cadena en una estructura que nadie va a consultar por partes.
--
--  Es NULL para las filas anteriores a esta migracion y para cualquier
--  evento que se genere sin telemetria activa. El relay lo trata como
--  "sin padre" y publica igual: la observabilidad no puede ser
--  requisito para que un paso llegue al Shift Service.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE access_svc.outbox_events
  ADD COLUMN trace_context VARCHAR(64);

COMMENT ON COLUMN access_svc.outbox_events.trace_context IS
  'Cabecera traceparent (W3C Trace Context) de la peticion que genero el evento. NULL si no habia telemetria activa.';
