-- ══════════════════════════════════════════════════════════════════
--  Inicialización de PostgreSQL
--
--  Se ejecuta UNA sola vez, al crear el volumen de datos.
--
--  Estrategia: una instancia, un schema por servicio y un rol por
--  servicio. El aislamiento entre microservicios queda impuesto por
--  los permisos de PostgreSQL, no por la disciplina del programador:
--  el Face Service no puede leer los registros de acceso aunque su
--  código lo intentase, y viceversa.
--
--  Cuando el proyecto crezca, separar esto en dos instancias es
--  trivial porque ya no comparten tablas.
-- ══════════════════════════════════════════════════════════════════

-- pgvector: tipo vector y búsqueda por similitud.
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Schemas ───────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS face_svc;
CREATE SCHEMA IF NOT EXISTS access_svc;

-- ── Roles por servicio ────────────────────────────────────────────
-- Las contraseñas llegan por variables de entorno del contenedor.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'face_svc_user') THEN
    EXECUTE format(
      'CREATE ROLE face_svc_user LOGIN PASSWORD %L',
      current_setting('custom.face_svc_password', true)
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'access_svc_user') THEN
    EXECUTE format(
      'CREATE ROLE access_svc_user LOGIN PASSWORD %L',
      current_setting('custom.access_svc_password', true)
    );
  END IF;
END
$$;

-- ── Permisos: cada servicio SOLO ve su propio schema ──────────────
GRANT USAGE, CREATE ON SCHEMA face_svc   TO face_svc_user;
GRANT USAGE, CREATE ON SCHEMA access_svc TO access_svc_user;

ALTER DEFAULT PRIVILEGES IN SCHEMA face_svc
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO face_svc_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA access_svc
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO access_svc_user;

-- Denegar explícitamente el acceso cruzado.
REVOKE ALL ON SCHEMA access_svc FROM face_svc_user;
REVOKE ALL ON SCHEMA face_svc   FROM access_svc_user;

-- Nadie usa el schema public.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- El tipo `vector` vive en public: hay que poder resolverlo.
GRANT USAGE ON SCHEMA public TO face_svc_user, access_svc_user;
