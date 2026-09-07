# ADR 0004 — Un schema y un rol de PostgreSQL por servicio

**Estado:** aceptada · 2026-09-07

## Contexto

En microservicios, cada servicio debe ser dueño de sus datos. Las
opciones eran: una base compartida, una base por servicio, o un punto
intermedio.

## Decisión

**Una instancia de PostgreSQL, un schema por servicio y un rol por
servicio.**

```
face_access (base de datos)
├── face_svc     → face_svc_user
└── access_svc   → access_svc_user
```

Con `REVOKE` explícito del acceso cruzado.

## Motivos

**Frente a una base compartida:** el aislamiento lo impone PostgreSQL,
no la buena voluntad. El Face Service no puede leer los registros de
acceso aunque su código lo intentara. Es una garantía verificable, no una
convención.

**Frente a una base por servicio:** dos instancias para un MVP suponen
el doble de copias de seguridad, de monitorización y de consumo de
memoria, sin beneficio a esta escala.

**Migración futura:** como los servicios ya no comparten tablas ni hacen
joins entre schemas, separarlos en instancias distintas es cambiar una
cadena de conexión.

## Consecuencia

No hay claves foráneas entre `access_svc.access_logs` y
`face_svc.persons`: son servicios distintos. La referencia es por
identificador y el nombre se guarda desnormalizado a propósito, porque un
asiento de auditoría debe ser inmutable y seguir describiendo lo que
ocurrió aunque la persona se renombre o se elimine.
