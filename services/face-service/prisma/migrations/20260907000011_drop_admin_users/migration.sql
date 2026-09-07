-- Retira `admin_users` del Face Service.
--
-- POR QUE
-- -------
-- La tabla estaba mal ubicada. `face_svc` es el dueño de las personas
-- que el sistema RECONOCE; las cuentas que ADMINISTRAN el sistema son
-- otro dominio y ahora viven en el Auth Service, bajo `auth_svc`, con
-- su propio rol de PostgreSQL.
--
-- La consecuencia práctica de la separación es que ningún otro servicio
-- puede leer los hashes de contraseñas, ni siquiera por error: el
-- permiso no existe a nivel de base de datos.
--
-- No hay migración de datos porque la tabla nunca llegó a usarse: el
-- inicio de sesión se implementó ya con el Auth Service en su sitio.
-- Si en algún despliegue hubiera filas, habría que exportarlas antes.

DROP TABLE IF EXISTS "admin_users";
