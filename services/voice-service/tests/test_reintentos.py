"""
Pruebas del reintento.

POR QUE ESTO MERECE TESTS
─────────────────────────
Dejo de ser una linea cuando se midio que los 503 de Gemini vienen por
RACHAS y no sueltos. Ahora tiene un bucle, una condicion de ultimo
intento y una espera que crece, y cada una de esas tres cosas puede
romperse de una forma distinta y silenciosa:

  · reintentar lo que no se debe reintentar -un 401- anade latencia a
    un error ya definitivo;
  · no reintentar lo que si -un 503- pierde la estructuracion de un
    parte que estaba bien;
  · tragarse la excepcion del ultimo intento deja a quien llama sin
    saber que paso.

Sin red: la peticion es una funcion de mentira que devuelve lo que se
le diga. Las esperas se saltan parcheando `asyncio.sleep`, porque una
prueba que tarda lo que tardan las esperas de verdad es una que nadie
ejecuta.

POR QUE UNA RESPUESTA DE MENTIRA Y NO UNA DE `httpx`
────────────────────────────────────────────────────
Para que la mayor parte de este archivo corra SIN INSTALAR NADA, igual
que `test_citas.py`. `con_reintento` solo mira `status_code`, asi que un
objeto con ese atributo basta.

Lo unico que si necesita `httpx` es probar los errores de TRANSPORTE,
porque la funcion los distingue por su tipo. Esos casos se saltan
cuando la libreria no esta —en la maquina de quien ejecuta el CI en
local— y se ejecutan donde si esta: en el contenedor y en el CI, que la
instala para esto.
"""

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import patch

try:
    import httpx
except ModuleNotFoundError:  # pragma: no cover
    httpx = None

from app.providers.reintentos import con_reintento

CON_HTTPX = unittest.skipUnless(
    httpx is not None,
    "httpx no esta instalado: los errores de transporte se prueban en el "
    "contenedor y en el CI",
)


def _respuesta(estado: int):
    """Lo minimo que `con_reintento` mira de una respuesta."""
    return SimpleNamespace(status_code=estado)


class Reintento(unittest.TestCase):
    def setUp(self):
        # Las esperas se saltan: lo que se prueba es cuantas veces se
        # intenta y con que criterio, no el reloj.
        parche = patch("asyncio.sleep", new=lambda _: asyncio.sleep(0))
        parche.start()
        self.addCleanup(parche.stop)

    @staticmethod
    def _correr(respuestas, **kwargs):
        """Ejecuta `con_reintento` sobre una lista de resultados."""
        llamadas = []

        async def peticion():
            resultado = respuestas[len(llamadas)]
            llamadas.append(resultado)
            if isinstance(resultado, Exception):
                raise resultado
            return _respuesta(resultado)

        resultado = asyncio.run(con_reintento(peticion, **kwargs))
        return resultado, len(llamadas)

    def test_a_la_primera_no_reintenta(self):
        respuesta, llamadas = self._correr([200])
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual(llamadas, 1)

    def test_un_503_se_reintenta(self):
        respuesta, llamadas = self._correr([503, 200])
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual(llamadas, 2)

    @CON_HTTPX
    def test_un_error_de_transporte_se_reintenta(self):
        respuesta, llamadas = self._correr([httpx.ConnectError("sin red"), 200])
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual(llamadas, 2)

    def test_un_401_no_se_reintenta(self):
        # Una clave mal puesta da lo mismo las veces que se pida.
        respuesta, llamadas = self._correr([401, 200])
        self.assertEqual(respuesta.status_code, 401)
        self.assertEqual(llamadas, 1)

    def test_un_413_no_se_reintenta(self):
        respuesta, llamadas = self._correr([413, 200])
        self.assertEqual(respuesta.status_code, 413)
        self.assertEqual(llamadas, 1)

    def test_tres_intentos_aguantan_una_racha_de_dos(self):
        # Es el caso que motivo el cambio: dos 503 seguidos y el tercero
        # bueno. Con dos intentos se habria perdido la estructuracion.
        respuesta, llamadas = self._correr([503, 503, 200], intentos=3)
        self.assertEqual(respuesta.status_code, 200)
        self.assertEqual(llamadas, 3)

    def test_no_intenta_mas_veces_de_las_pedidas(self):
        respuesta, llamadas = self._correr([503, 503, 503], intentos=3)
        self.assertEqual(respuesta.status_code, 503)
        self.assertEqual(llamadas, 3)

    @CON_HTTPX
    def test_el_ultimo_error_de_transporte_se_propaga(self):
        # Quien llama sabe degradarse, y necesita el error para hacerlo.
        with self.assertRaises(httpx.ConnectError):
            self._correr(
                [httpx.ConnectError("uno"), httpx.ConnectError("dos")], intentos=2
            )

    def test_avisa_de_cada_reintento_y_con_el_motivo(self):
        motivos = []
        self._correr([503, 500, 200], intentos=3, al_reintentar=motivos.append)
        self.assertEqual(motivos, ["estado 503", "estado 500"])

    @CON_HTTPX
    def test_el_motivo_de_un_error_de_transporte_es_su_tipo(self):
        motivos = []
        self._correr(
            [httpx.ConnectError("sin red"), 200],
            al_reintentar=motivos.append,
        )
        self.assertEqual(motivos, ["ConnectError"])

    def test_la_espera_crece_entre_intentos(self):
        # Una espera fija y corta cae dentro de la misma racha y gasta
        # el intento para nada: por eso crece.
        esperas = []

        async def registrar(segundos):
            esperas.append(segundos)

        with patch("asyncio.sleep", new=registrar):
            self._correr([503, 503, 200], intentos=3, espera_s=0.5)

        self.assertEqual(esperas, [0.5, 1.5])


if __name__ == "__main__":
    unittest.main()
