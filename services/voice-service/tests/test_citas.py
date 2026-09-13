"""
Pruebas de la comprobacion de citas.

POR QUE `unittest` Y NO PYTEST
─────────────────────────────
Porque `app/services/citas.py` no depende de nada fuera de la
biblioteca estandar, y asi estas pruebas corren en el CI sin instalar
absolutamente nada: ni fastapi, ni httpx, ni pytest. El proyecto ya
aprendio con el frontend que unos tests que no se ejecutan son
decoracion, y la forma mas segura de que estos se ejecuten siempre es
que no necesiten preparacion ninguna.

    python -m unittest discover -s tests

Si algun dia hay que probar aqui algo que si necesite dependencias,
ese archivo puede usar pytest; este no lo necesita.

QUE SE PRUEBA, Y POR QUE ESO
────────────────────────────
La unica garantia de este servicio que no depende de un tercero: que
una incidencia cuya cita no esta en la transcripcion queda MARCADA. Es
la diferencia entre pedirle a un modelo que no invente y comprobar que
no invento, y si esta comprobacion se afloja sin querer, el sistema
deja de avisar de lo unico que sabe detectar.
"""

import unicodedata
import unittest

from app.services.citas import cita_respaldada, normalizar, verificar_incidencias

PARTE = unicodedata.normalize(
    "NFC",
    (
    "Relevo del turno de noche. Sin novedad hasta las tres y cuarto, que "
    "saltó el sensor del muelle de carga. Bajé a comprobarlo y era una "
    "puerta mal cerrada, la aseguré y dejé la zona conforme. El ascensor "
    "del ala norte sigue haciendo ruido, lo reporté el martes pasado."
    ),
)


class CitaRespaldada(unittest.TestCase):
    def test_cita_copiada_literalmente(self):
        self.assertTrue(
            cita_respaldada("saltó el sensor del muelle de carga", PARTE)
        )

    def test_ignora_mayusculas_y_puntuacion(self):
        # Un modelo que copia bien puede comerse una coma o empezar la
        # cita en mayuscula. Eso no es inventarse nada.
        self.assertTrue(
            cita_respaldada("Puerta mal cerrada la aseguré,", PARTE)
        )

    def test_ignora_espacios_de_mas(self):
        self.assertTrue(
            cita_respaldada("el   ascensor\n del  ala norte", PARTE)
        )

    def test_acentos_compuestos_de_otra_forma(self):
        # La misma "e" acentuada puede venir como UN caracter (NFC) o
        # como dos, la letra y la tilde suelta (NFD). A la vista son
        # identicas y byte a byte no lo son, asi que sin normalizar una
        # cita bien copiada saldria marcada como inventada.
        #
        # Se descompone AQUI en lugar de pegar el texto ya descompuesto:
        # la diferencia es invisible al leer el archivo, y una prueba
        # que depende de un byte que no se ve deja de probar nada en
        # cuanto un editor normaliza el fichero al guardarlo.
        original = "la aseguré y dejé la zona conforme"
        descompuesta = unicodedata.normalize("NFD", original)

        self.assertNotEqual(descompuesta, original)
        self.assertTrue(cita_respaldada(descompuesta, PARTE))

    def test_frase_inventada(self):
        self.assertFalse(
            cita_respaldada("se activó la alarma de incendios", PARTE)
        )

    def test_palabras_reordenadas(self):
        # Mismo vocabulario, otro orden: es una reescritura, no una cita.
        self.assertFalse(
            cita_respaldada("del muelle de carga el sensor saltó", PARTE)
        )

    def test_los_acentos_si_cuentan(self):
        # "asegure" y "aseguré" son formas verbales distintas. Quitar
        # los acentos para comparar aflojaria la comprobacion sin ganar
        # nada, porque la transcripcion viene acentuada.
        self.assertFalse(cita_respaldada("la asegure y deje la zona", PARTE))

    def test_cita_vacia(self):
        # El modelo tenia que senalar donde lo leyo y no lo hizo.
        self.assertFalse(cita_respaldada("", PARTE))
        self.assertFalse(cita_respaldada("   ", PARTE))
        self.assertFalse(cita_respaldada(",.-", PARTE))

    def test_transcripcion_vacia(self):
        self.assertFalse(cita_respaldada("cualquier cosa", ""))


class Normalizacion(unittest.TestCase):
    def test_deja_una_secuencia_de_palabras(self):
        self.assertEqual(
            normalizar("  ¡Hola,   MUNDO!  \n ¿qué tal? "), "hola mundo qué tal"
        )

    def test_texto_vacio(self):
        self.assertEqual(normalizar(""), "")


class VerificarIncidencias(unittest.TestCase):
    def test_marca_cada_incidencia_y_cuenta_las_no_respaldadas(self):
        incidencias = [
            {"titulo": "Sensor del muelle", "citaLiteral": "saltó el sensor del muelle"},
            {"titulo": "Incendio", "citaLiteral": "se declaró un incendio"},
            {"titulo": "Ascensor", "citaLiteral": "sigue haciendo ruido"},
        ]

        revisadas, sin_respaldo = verificar_incidencias(incidencias, PARTE)

        self.assertEqual([i["citaVerificada"] for i in revisadas], [True, False, True])
        self.assertEqual(sin_respaldo, 1)

    def test_no_descarta_las_no_respaldadas(self):
        # Borrarlas esconderia que el modelo se invento algo, que es
        # justo lo que quien revisa el borrador necesita ver.
        revisadas, _ = verificar_incidencias(
            [{"titulo": "Inventada", "citaLiteral": "nada de esto se dijo"}], PARTE
        )
        self.assertEqual(len(revisadas), 1)
        self.assertEqual(revisadas[0]["titulo"], "Inventada")

    def test_conserva_los_demas_campos(self):
        revisadas, _ = verificar_incidencias(
            [
                {
                    "titulo": "Ascensor",
                    "categoria": "MANTENIMIENTO",
                    "gravedad": "MEDIA",
                    "requiereSeguimiento": True,
                    "citaLiteral": "sigue haciendo ruido",
                }
            ],
            PARTE,
        )
        self.assertEqual(revisadas[0]["categoria"], "MANTENIMIENTO")
        self.assertTrue(revisadas[0]["requiereSeguimiento"])

    def test_incidencia_sin_cita(self):
        revisadas, sin_respaldo = verificar_incidencias([{"titulo": "Suelta"}], PARTE)
        self.assertFalse(revisadas[0]["citaVerificada"])
        self.assertEqual(sin_respaldo, 1)

    def test_lista_vacia(self):
        revisadas, sin_respaldo = verificar_incidencias([], PARTE)
        self.assertEqual(revisadas, [])
        self.assertEqual(sin_respaldo, 0)


if __name__ == "__main__":
    unittest.main()
