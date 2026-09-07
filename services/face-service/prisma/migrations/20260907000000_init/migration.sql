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
CREATE TYPE "PersonStatus" AS ENUM ('ACTIVE', 'SUSPENDED');

-- CreateTable
CREATE TABLE "persons" (
    "id" UUID NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "external_id" VARCHAR(64),
    "status" "PersonStatus" NOT NULL DEFAULT 'ACTIVE',
    "deleted_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "persons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "face_embeddings" (
    "id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "embedding" vector(512) NOT NULL,
    "model_name" VARCHAR(80) NOT NULL,
    "model_version" VARCHAR(20) NOT NULL,
    "det_score" REAL NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "face_embeddings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(160) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(120) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "persons_external_id_key" ON "persons"("external_id");

-- CreateIndex
CREATE INDEX "persons_status_deleted_at_idx" ON "persons"("status", "deleted_at");

-- CreateIndex
CREATE INDEX "face_embeddings_person_id_idx" ON "face_embeddings"("person_id");

-- CreateIndex
CREATE INDEX "face_embeddings_model_name_model_version_idx" ON "face_embeddings"("model_name", "model_version");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- AddForeignKey
ALTER TABLE "face_embeddings" ADD CONSTRAINT "face_embeddings_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "persons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
