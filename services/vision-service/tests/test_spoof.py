"""
Pruebas del detector de vida (MiniFASNet).

POR QUE ESTAS Y NO UNA MEDIDA DE ACIERTO
────────────────────────────────────────
Si el modelo acierta o no es una pregunta de datos, y tiene su propia
herramienta: `node scripts/measure-liveness.mjs` lo pasa por el conjunto
de ataque y saca APCER y BPCER. Repetir aquí una versión pobre de eso no
añadiría nada.

Lo que se prueba aquí es lo que puede romperse SIN QUE SE NOTE:

  · que el modelo esté viendo la imagen y no una versión aplastada de
    ella —la trampa del `/255`, que costó una tarde—;
  · que un fallo midiendo devuelva ausencia y nunca un cero, porque un
    cero es «ataque segurísimo» y en modo HARD deja gente en la calle;
  · que la falta de un peso reviente al cargar, en vez de dejar el
    servicio en pie sin detección de vida.

ESTAS PRUEBAS NO CORREN EN EL CI, Y ES A PROPOSITO
──────────────────────────────────────────────────
Necesitan torch (cientos de megas) y los dos pesos. El CI de este
servicio compila e ejecuta solo `test_medir*.py`. Para correr estas, el
sitio natural es el contenedor, que ya tiene las dos cosas:

    docker compose cp services/vision-service/tests/test_spoof.py \\
        vision-service:/tmp/test_spoof.py
    docker compose exec -T vision-service python -m unittest \\
        /tmp/test_spoof.py

Si falta torch o faltan los pesos, se saltan con su motivo en vez de
fallar: un entorno sin modelos no es un error del código.
"""

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, "/app")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import numpy as np  # noqa: E402


def _directorio_de_modelos() -> Path | None:
    """
    Donde estan los pesos, en el contenedor o en el arbol de trabajo.

    Se busca por el archivo, no por el directorio: copiado a /tmp dentro
    del contenedor este archivo no tiene arbol de proyecto encima, y ahi
    la ruta relativa al repositorio ni siquiera existe.
    """
    aqui = Path(__file__).resolve()
    candidatos = [os.environ.get("ANTISPOOF_MODELS_DIR"), "/app/modelos/antispoof"]
    if len(aqui.parents) > 3:
        candidatos.append(str(aqui.parents[3] / "modelos" / "antispoof"))

    for candidato in candidatos:
        if candidato and (Path(candidato) / "2.7_80x80_MiniFASNetV2.pth").is_file():
            return Path(candidato)
    return None


try:
    import torch  # noqa: F401

    HAY_TORCH = True
except ImportError:
    HAY_TORCH = False

MODELOS = _directorio_de_modelos()

requiere_modelos = unittest.skipUnless(
    HAY_TORCH and MODELOS is not None,
    "hacen falta torch y los pesos de modelos/antispoof",
)


def _cuadro(valor, lado=300):
    """Una imagen lisa del valor dado."""
    return np.full((lado, lado, 3), valor, dtype=np.uint8)


CAJA = (50, 50, 200, 200)


@requiere_modelos
class NoEstaCiego(unittest.TestCase):
    """
    La prueba que justifica este archivo.

    Estos modelos esperan la entrada en 0-255. Alimentados en [0, 1] no
    fallan de forma visible: responden EXACTAMENTE lo mismo a una cara,
    a ruido puro y a una imagen negra. Parece un modelo que no
    generaliza cuando en realidad no está viendo nada, y la primera
    evaluación de este proyecto se fue por ahí.

    No hay forma de detectar eso mirando el código: el `.div(255)` de
    más o de menos es una línea que parece correcta. Lo único que lo
    delata es que las respuestas dejen de depender de la entrada.
    """

    @classmethod
    def setUpClass(cls):
        from app.recognition.spoof import SpoofDetector

        cls.detector = SpoofDetector(MODELOS)
        cls.detector.load()

    def test_entradas_distintas_dan_respuestas_distintas(self):
        rng = np.random.default_rng(7)
        entradas = {
            "negro": _cuadro(0),
            "gris": _cuadro(128),
            "blanco": _cuadro(255),
            "ruido": rng.integers(0, 256, (300, 300, 3), dtype=np.uint8),
        }

        puntuaciones = {
            nombre: self.detector.score(imagen, CAJA).real_score
            for nombre, imagen in entradas.items()
        }

        separacion = max(puntuaciones.values()) - min(puntuaciones.values())
        self.assertGreater(
            separacion,
            0.30,
            "el modelo responde casi igual a entradas muy distintas "
            f"({puntuaciones}). Es lo que pasa cuando la entrada llega "
            "en [0,1] en vez de en 0-255: ver "
            "modelos/antispoof/PROCEDENCIA.md",
        )

    def test_la_puntuacion_es_una_probabilidad(self):
        # Se PROMEDIAN los dos modelos. Si algún día se sumaran sin
        # dividir, el número se saldría de [0, 1] y `minSpoofScore`
        # dejaría de significar lo que dice significar.
        #
        # Hace falta una entrada que puntúe ALTO para que esto muerda:
        # con una imagen gris los dos modelos dan tan poco que ni
        # sumados pasan de 1, y la mutación se colaría entera. Se probó.
        rng = np.random.default_rng(7)
        entradas = [
            _cuadro(128),
            _cuadro(0),
            rng.integers(0, 256, (300, 300, 3), dtype=np.uint8),
        ]
        for imagen in entradas:
            evidencia = self.detector.score(imagen, CAJA)
            self.assertGreaterEqual(evidencia.real_score, 0.0)
            self.assertLessEqual(
                evidencia.real_score,
                1.0,
                "la puntuación se ha salido de [0, 1]: los dos modelos se "
                "están sumando en vez de promediarse",
            )
            self.assertIn(evidencia.label, (0, 1, 2))


@requiere_modelos
class FalloDeMedida(unittest.TestCase):
    """
    Un fallo midiendo devuelve AUSENCIA, nunca cero.

    Cero significa «ataque segurísimo». Si un error de código produjera
    un cero, en modo HARD dejaría a una persona real en la calle y
    parecería que el sistema funciona. Por eso la mitad de esta decisión
    está aquí y la otra en `judgeFrame`, que no trata la ausencia como
    sospecha.
    """

    @classmethod
    def setUpClass(cls):
        from app.recognition.spoof import SpoofDetector

        cls.detector = SpoofDetector(MODELOS)
        cls.detector.load()

    def test_caja_degenerada(self):
        evidencia = self.detector.score(_cuadro(128), (10, 10, 0, 0))
        self.assertIsNone(evidencia, "una caja vacía tiene que dar ausencia")

    def test_imagen_vacia(self):
        self.assertIsNone(self.detector.score(np.zeros((0, 0, 3), np.uint8), CAJA))
        self.assertIsNone(self.detector.score(None, CAJA))

    def test_una_caja_imposible_no_lanza(self):
        # Un rostro que falla no puede tumbar el frame completo.
        evidencia = self.detector.score(_cuadro(128), (-5000, -5000, 10, 10))
        self.assertTrue(evidencia is None or 0.0 <= evidencia.real_score <= 1.0)

    def test_una_excepcion_al_medir_sale_como_AUSENCIA(self):
        # Las comprobaciones de arriba salen por los guardas de entrada,
        # que devuelven None antes de tocar el modelo. Esta entra por el
        # `except`, que es el camino que de verdad importa: es el que
        # recorrería un fallo inesperado en producción.
        #
        # Sin esto el archivo no cubría lo que decía cubrir. Se
        # descubrió cambiando ese `return None` por un
        # `real_score=0.0` y viendo que los siete tests seguían en
        # verde.
        class CropperRoto:
            def crop(self, *_args, **_kwargs):
                raise RuntimeError("cv2 se cayo a mitad")

        original = self.detector._cropper
        self.detector._cropper = CropperRoto()
        try:
            evidencia = self.detector.score(_cuadro(128), CAJA)
        finally:
            self.detector._cropper = original

        self.assertIsNone(
            evidencia,
            "un fallo midiendo tiene que salir como ausencia. Un 0.0 "
            "significa «ataque segurísimo» y en modo HARD dejaría a una "
            "persona real en la calle por un error de código.",
        )


class Carga(unittest.TestCase):
    def test_sin_cargar_no_puntua(self):
        from app.core.errors import ModelNotReadyError
        from app.recognition.spoof import SpoofDetector

        detector = SpoofDetector(MODELOS or Path("/inexistente"))
        with self.assertRaises(ModelNotReadyError):
            detector.score(_cuadro(128), CAJA)

    @unittest.skipUnless(HAY_TORCH, "hace falta torch")
    def test_si_falta_un_peso_revienta_al_cargar(self):
        # Deliberadamente NO se degrada a «arranca sin detección de
        # vida»: eso dejaría al Access Service sin evidencia, y sin
        # evidencia no hay sospecha. La protección se habría apagado en
        # silencio. Un contenedor que no levanta se ve.
        from app.core.errors import ModelNotReadyError
        from app.recognition.spoof import SpoofDetector

        detector = SpoofDetector(Path("/no/existe/este/directorio"))
        with self.assertRaises(ModelNotReadyError):
            detector.load()
        self.assertFalse(detector.is_ready)


if __name__ == "__main__":
    unittest.main()
