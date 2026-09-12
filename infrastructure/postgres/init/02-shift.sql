-- ══════════════════════════════════════════════════════════════════
--  Schema y rol del Shift Service
--
--  Va en un archivo aparte y no dentro de 01-init.sql por un motivo
--  practico: los scripts de /docker-entrypoint-initdb.d SOLO se
--  ejecutan al crear el volumen de datos. Quien ya tenga una base de
--  datos en marcha no vería este schema nunca, y tocar 01-init.sql
--  tampoco se lo daría.
--
--  Estando aparte y siendo idempotente, se puede aplicar a mano sobre
--  una instalación existente sin perder los rostros ya enrolados:
--
--    docker compose exec -T postgres \
--      psql -v ON_ERROR_STOP=1 -U facedetector -d face_access \
--      -c "SET custom.shift_svc_password = 'la-del-.env';" \
--      -f /docker-entrypoint-initdb.d/02-shift.sql
--
--  O, mas comodo, con el script que lo hace por ti:
--
--    node scripts/apply-shift-schema.mjs
-- ══════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS shift_svc;

-- ── Rol del servicio ──────────────────────────────────────────────
--
-- La contraseña llega como opcion de sesion, igual que las de los
-- demas roles: asi no queda escrita en el propio SQL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'shift_svc_user') THEN
    EXECUTE format(
      'CREATE ROLE shift_svc_user LOGIN PASSWORD %L',
      current_setting('custom.shift_svc_password', true)
    );
  END IF;
END
$$;

GRANT USAGE, CREATE ON SCHEMA shift_svc TO shift_svc_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA shift_svc
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO shift_svc_user;

-- Por si el schema ya tenia tablas creadas antes de este GRANT.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA shift_svc TO shift_svc_user;

-- ── Aislamiento cruzado ───────────────────────────────────────────
--
-- El Shift Service calcula horas trabajadas; no tiene ningun motivo
-- para poder leer vectores faciales ni hashes de contraseñas. Y al
-- reves: que el Access Service no pueda tocar las horas de nadie es
-- justamente lo que hace creible el registro de jornada.
REVOKE ALL ON SCHEMA shift_svc
  FROM face_svc_user, access_svc_user, auth_svc_user;
REVOKE ALL ON SCHEMA face_svc   FROM shift_svc_user;
REVOKE ALL ON SCHEMA access_svc FROM shift_svc_user;
REVOKE ALL ON SCHEMA auth_svc   FROM shift_svc_user;

ALTER ROLE shift_svc_user SET search_path = shift_svc;
