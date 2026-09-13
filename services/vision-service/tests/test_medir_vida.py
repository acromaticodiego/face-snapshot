"""
Pruebas de la aritmetica del medidor de vida.

POR QUE ESTO Y NO UNA PRUEBA CON IMAGENES
─────────────────────────────────────────
Lo que puede estar mal en `medir_vida.py` no son las imagenes, es lo
que concluye. Y eso se prueba con numeros:

  · si el mejor corte posible separa o no;
  · si la senal apunta en la direccion que deberia;
  · y sobre todo, que NO declare exito cuando no ha medido nada.

Ese ultimo caso no es hipotetico: la primera version daba por bueno
"la senal separa" con cero caras detectadas, porque no encontraba
indicios de lo contrario. Un medidor que declara exito habiendo medido
nada es peor que uno que falla, porque el numero que da no es
optimista: es inventado. De ahi salio este archivo.

`medir_vida.py` solo importa de la biblioteca estandar, asi que esto
corre sin instalar nada, igual que el resto de tests de este servicio.
"""

import contextlib
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from medir_vida import informar, mejor_corte  # noqa: E402


def bloque(detalle, pico, sin_cara=0, varias=0):
    return {
        "total": len(detalle) + sin_cara,
        "medidas": len(detalle),
        "sin_cara": sin_cara,
        "varias_caras": varias,
        "detalle": detalle,
        "pico": pico,
    }


def conjunto(partes):
    """Un resultado completo; lo que no se pase queda vacio."""
    base = {
        (clase, variante): bloque([], [])
        for clase in ("real", "pantalla")
        for variante in ("terminal", "nativo")
    }
    base.update(partes)
    return base


class MejorCorte(unittest.TestCase):
    def test_dos_nubes_separadas_se_cortan_sin_error(self):
        # El ataque da MENOS: el corte deja cada clase a un lado.
        corte, apcer, bpcer = mejor_corte(
            reales=[0.50, 0.52, 0.55],
            ataques=[0.20, 0.22, 0.25],
            ataque_es_menor=True,
        )
        self.assertEqual(apcer, 0.0)
        self.assertEqual(bpcer, 0.0)
        self.assertTrue(0.25 < corte < 0.50)

    def test_dos_nubes_identicas_no_se_pueden_separar(self):
        # Es el caso que importa: con las dos clases encima, cualquier
        # corte se equivoca en una de las dos.
        _, apcer, bpcer = mejor_corte(
            reales=[0.40, 0.41, 0.42],
            ataques=[0.40, 0.41, 0.42],
            ataque_es_menor=True,
        )
        self.assertGreaterEqual(apcer + bpcer, 0.9)

    def test_reconoce_la_direccion_contraria(self):
        # Si el ataque da MAS y se busca el corte por debajo, el mejor
        # resultado posible es pesimo. Es lo que se midio el 2026-09-13.
        _, apcer, bpcer = mejor_corte(
            reales=[0.20, 0.22],
            ataques=[0.50, 0.55],
            ataque_es_menor=True,
        )
        self.assertGreaterEqual(apcer + bpcer, 0.9)

    def test_el_corte_por_arriba_tambien_funciona(self):
        corte, apcer, bpcer = mejor_corte(
            reales=[14.0, 15.0],
            ataques=[140.0, 150.0],
            ataque_es_menor=False,
        )
        self.assertEqual(apcer, 0.0)
        self.assertEqual(bpcer, 0.0)
        self.assertTrue(15.0 < corte < 140.0)

    def test_sin_datos_no_hay_corte(self):
        self.assertIsNone(mejor_corte([], [0.1], True))
        self.assertIsNone(mejor_corte([0.1], [], True))


class Veredicto(unittest.TestCase):
    """El codigo de salida es el veredicto, y tiene tres valores."""

    @staticmethod
    def _veredicto(resultados):
        """
        Ejecuta el informe y devuelve (codigo, texto).

        La salida se CAPTURA, y no solo para no llenar la consola de
        informes: el script dibuja recuadros con caracteres unicode, y
        una consola de Windows en cp1252 revienta al imprimirlos. Dentro
        del contenedor eso no pasa, pero estos tests corren en el host.
        """
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            codigo = informar(resultados)
        return codigo, buffer.getvalue()

    def test_cero_medidas_NO_es_exito(self):
        # La regresion que motivo este archivo.
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque([], [], sin_cara=8),
                ("pantalla", "terminal"): bloque([], [], sin_cara=8),
            })
        )
        self.assertEqual(salida, 2, "cero medidas tiene que ser un error")
        self.assertIn("NO SE PUDO MEDIR NADA", texto)

    def test_una_senal_al_reves_da_veredicto_negativo(self):
        # La pantalla dando MAS detalle fino que la cara real, que es lo
        # que de verdad se midio.
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(
                    [0.38, 0.40, 0.44], [24.8, 34.0, 43.6]
                ),
                ("pantalla", "terminal"): bloque(
                    [0.45, 0.46, 0.48], [23.7, 25.0, 28.9]
                ),
            })
        )
        self.assertEqual(salida, 1)
        # El informe tiene que DECIR que va al reves, no solo suspender.
        self.assertIn("AL REVES", texto)

    def test_dos_senales_que_separan_dan_veredicto_positivo(self):
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(
                    [0.56, 0.57, 0.58], [13.0, 14.0, 15.0]
                ),
                ("pantalla", "terminal"): bloque(
                    [0.30, 0.31, 0.32], [140.0, 149.0, 155.0]
                ),
            })
        )
        self.assertEqual(salida, 0)
        self.assertNotIn("AL REVES", texto)

    def test_separacion_mala_aunque_vaya_en_la_direccion_correcta(self):
        # Las nubes se solapan: la direccion es la buena pero el mejor
        # corte posible se sigue equivocando demasiado.
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(
                    [0.40, 0.42, 0.44], [14.0, 20.0, 30.0]
                ),
                ("pantalla", "terminal"): bloque(
                    [0.39, 0.41, 0.43], [15.0, 21.0, 31.0]
                ),
            })
        )
        self.assertEqual(salida, 1)
        self.assertIn("INSERVIBLE", texto)


if __name__ == "__main__":
    unittest.main()
