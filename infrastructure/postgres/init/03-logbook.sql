-- ══════════════════════════════════════════════════════════════════
--  Schema y rol del Logbook Service
--
--  Mismo patron que 02-shift.sql, y por el mismo motivo practico: los
--  scripts de /docker-entrypoint-initdb.d SOLO se ejecutan al crear el
--  volumen de datos. Quien ya tenga una base de datos en marcha no
--  veria este schema nunca.
--
--  Estando aparte y siendo idempotente, se puede aplicar a mano sobre
--  una instalacion existente sin perder nada:
--
--    node scripts/apply-logbook-schema.mjs
-- ══════════════════════════════════════════════════════════════════

CREATE SCHEMA IF NOT EXISTS logbook_svc;

-- ── Rol del servicio ──────────────────────────────────────────────
--
-- La contrasena llega como opcion de sesion, igual que las de los
-- demas roles: asi no queda escrita en el propio SQL.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logbook_svc_user') THEN
    EXECUTE format(
      'CREATE ROLE logbook_svc_user LOGIN PASSWORD %L',
      current_setting('custom.logbook_svc_password', true)
    );
  END IF;
END
$$;

GRANT USAGE, CREATE ON SCHEMA logbook_svc TO logbook_svc_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA logbook_svc
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO logbook_svc_user;

-- Por si el schema ya tenia tablas creadas antes de este GRANT.
GRANT SELECT, INSERT, UPDATE, DELETE
  ON ALL TABLES IN SCHEMA logbook_svc TO logbook_svc_user;

-- ── Aislamiento cruzado ───────────────────────────────────────────
--
-- La bitacora guarda el testimonio de una persona sobre su turno. No
-- tiene ningun motivo para leer vectores faciales ni hashes de
-- contrasenas, y sobre todo: NADIE MAS debe poder escribir en ella.
--
-- Eso ultimo es la razon de ser del aislamiento aqui. Un parte de
-- relevo vale porque lo firmo quien vivio el turno; si otro servicio
-- pudiera insertar filas en esta tabla, dejaria de poder afirmarse.
REVOKE ALL ON SCHEMA logbook_svc
  FROM face_svc_user, access_svc_user, auth_svc_user, shift_svc_user;
REVOKE ALL ON SCHEMA face_svc   FROM logbook_svc_user;
REVOKE ALL ON SCHEMA access_svc FROM logbook_svc_user;
REVOKE ALL ON SCHEMA auth_svc   FROM logbook_svc_user;
REVOKE ALL ON SCHEMA shift_svc  FROM logbook_svc_user;

ALTER ROLE logbook_svc_user SET search_path = logbook_svc;
