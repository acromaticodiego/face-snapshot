-- El schema y la extension `vector` NO se crean aqui.
--
-- Los crea infrastructure/postgres/init/01-init.sql, que se ejecuta una
-- sola vez como superusuario. Los roles de servicio tienen permiso para
-- crear TABLAS dentro de su schema, pero deliberadamente NO para crear
-- schemas ni extensiones: es justo el privilegio que no queremos que
-- tenga un servicio de aplicacion.
--
-- Prisma genera esas sentencias automaticamente; se retiran a proposito.

-- CreateEnum
CREATE TYPE "AccessReason" AS ENUM ('GRANTED', 'BELOW_THRESHOLD', 'NO_FACE_DETECTED', 'MULTIPLE_FACES', 'LOW_QUALITY', 'INSUFFICIENT_VOTES', 'PERSON_SUSPENDED');

-- CreateTable
CREATE TABLE "access_logs" (
    "id" UUID NOT NULL,
    "person_id" UUID,
    "person_name" VARCHAR(120),
    "authenticated" BOOLEAN NOT NULL,
    "confidence" REAL NOT NULL,
    "reason" "AccessReason" NOT NULL,
    "camera_id" VARCHAR(60) NOT NULL DEFAULT 'default',
    "session_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_sessions" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "person_name" VARCHAR(120) NOT NULL,
    "issued_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),

    CONSTRAINT "access_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_logs_person_id_idx" ON "access_logs"("person_id");

-- CreateIndex
CREATE INDEX "access_logs_created_at_idx" ON "access_logs"("created_at");

-- CreateIndex
CREATE INDEX "access_logs_authenticated_created_at_idx" ON "access_logs"("authenticated", "created_at");

-- CreateIndex
CREATE INDEX "access_sessions_person_id_idx" ON "access_sessions"("person_id");

-- CreateIndex
CREATE INDEX "access_sessions_expires_at_idx" ON "access_sessions"("expires_at");
