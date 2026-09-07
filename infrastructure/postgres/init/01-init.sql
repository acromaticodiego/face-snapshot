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

-- ── Schemas ───────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS face_svc;
CREATE SCHEMA IF NOT EXISTS access_svc;

-- ── pgvector ──────────────────────────────────────────────────────
--
-- La extension se instala DENTRO de face_svc, no en public.
--
-- Motivo: la cadena de conexion de Prisma lleva `?schema=face_svc`, y eso
-- fija el search_path de CADA CONEXION a ese unico schema, anulando
-- cualquier search_path configurado a nivel de rol. Con la extension en
-- public, ni el tipo `vector` ni el operador de distancia coseno `<=>`
-- se resolverian: fallarian las migraciones y las busquedas por
-- similitud en ejecucion.
--
-- Instalarla en el schema que la usa tambien encaja con el diseno: cada
-- servicio es dueno de todo lo que hay dentro de su schema.
CREATE EXTENSION IF NOT EXISTS vector SCHEMA face_svc;

-- No se instala uuid-ossp: gen_random_uuid() forma parte del nucleo de
-- PostgreSQL desde la version 13.

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

-- search_path por defecto de cada rol.
--
-- Prisma lo sobrescribe por conexion con `?schema=`, asi que esto solo
-- afecta a conexiones manuales (psql, copias de seguridad, scripts).
-- Sin ello, un `psql -U face_svc_user` no encontraria sus propias tablas.
ALTER ROLE face_svc_user   SET search_path = face_svc;
ALTER ROLE access_svc_user SET search_path = access_svc;
