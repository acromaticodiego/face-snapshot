-- Índice HNSW para búsqueda por similitud coseno.
--
-- Prisma no sabe generar índices sobre columnas de tipo Unsupported,
-- así que se crea aquí a mano.
--
-- POR QUE HNSW Y NO IVFFLAT:
--   · HNSW no necesita entrenamiento previo ni un número mínimo de
--     filas: funciona bien desde el primer registro, que es justo el
--     caso de un sistema que empieza vacío.
--   · IVFFlat exige reconstruir el índice conforme crecen los datos.
--
-- POR QUE vector_cosine_ops:
--   Los embeddings salen normalizados L2 desde el Vision Service, así
--   que la distancia coseno (operador <=>) es la métrica correcta.
--   similitud = 1 - distancia.
--
-- Con menos de ~1.000 personas PostgreSQL puede preferir un escaneo
-- secuencial, y estará en lo cierto: el índice empieza a compensar a
-- partir de varios miles de vectores. Se crea ya para no tener que
-- migrar en caliente más adelante.

CREATE INDEX IF NOT EXISTS "face_embeddings_embedding_hnsw_idx"
  ON "face_svc"."face_embeddings"
  USING hnsw ("embedding" vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
