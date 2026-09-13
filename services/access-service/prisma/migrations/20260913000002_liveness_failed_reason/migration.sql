-- ══════════════════════════════════════════════════════════════════
--  Motivo de denegacion por sospecha de suplantacion
--
--  Se anade al enum en lugar de reutilizar LOW_QUALITY, que es lo
--  facil y lo equivocado: una captura de mala calidad es un problema
--  de la camara o de la luz, y una sospecha de suplantacion es un
--  intento de entrar con una foto. Quien opera el sistema investiga
--  cada uno en un sitio distinto, y esa separacion es la razon de ser
--  de este enum, igual que separa "no te reconozco" de "te reconozco
--  pero no puedes pasar".
--
--  ALTER TYPE ... ADD VALUE dentro de una transaccion esta permitido
--  desde PostgreSQL 12 siempre que el valor nuevo no se USE en esa
--  misma transaccion. Aqui solo se declara, asi que Prisma puede
--  aplicarla como cualquier otra migracion.
-- ══════════════════════════════════════════════════════════════════

ALTER TYPE access_svc."AccessReason" ADD VALUE IF NOT EXISTS 'LIVENESS_FAILED';
