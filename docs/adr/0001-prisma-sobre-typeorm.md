# ADR 0001 — Prisma en lugar de TypeORM

**Estado:** aceptada · 2026-09-07

## Contexto

Los servicios NestJS necesitan un ORM. El requisito diferencial es que
`face_embeddings` guarda una columna `vector(512)` de pgvector, un tipo
que ningún ORM de TypeScript soporta de forma nativa.

## Decisión

**Prisma 7.10.0.**

## Motivos

| Criterio | Prisma | TypeORM |
|---|---|---|
| Tipado | Generado del schema, exacto | Decoradores; los tipos mienten en relaciones |
| Migraciones | Deterministas y versionadas | Frágiles; `synchronize: true` es una trampa |
| Multi-schema PostgreSQL | Soporte nativo | Manual |
| Mantenimiento | Muy activo | Histórico irregular |

## Consecuencia sobre pgvector

Prisma no expone el tipo `vector`. La columna se declara
`Unsupported("vector(512)")`: Prisma la gestiona en las migraciones pero
no la incluye en el cliente tipado. Las consultas de similitud usan
`$queryRaw` parametrizado, concentradas en `FacesRepository`.

**Esto resultó ser una ventaja, no una limitación.** Al no existir en el
cliente, devolver un embedding por accidente en una respuesta HTTP es
imposible. La regla "no exponer embeddings" queda garantizada por el
sistema de tipos y no por la disciplina de quien programa.

TypeORM habría tenido la misma limitación con peores migraciones.

## Nota sobre Prisma 7

La versión 7 eliminó `url` del bloque `datasource`. La conexión vive en
`prisma.config.ts` (migraciones) y en un adaptador `PrismaPg` construido
en `PrismaService` (ejecución). Efecto colateral positivo: el
`schema.prisma` versionado ya no referencia credenciales.
