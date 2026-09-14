"""
Pruebas de la aritmetica del medidor de vida.

POR QUE ESTO Y NO UNA PRUEBA CON IMAGENES
─────────────────────────────────────────
Lo que puede estar mal en `medir_vida.py` no son las imagenes, es lo
que concluye. Y eso se prueba con numeros:

  · si el mejor corte posible separa o no;
  · si la senal apunta en la direccion que deberia;
  · si un corte elegido en una sesion aguanta en otra;
  · y sobre todo, que NO declare exito cuando no ha medido nada.

Ese ultimo caso no es hipotetico: la primera version daba por bueno
"la senal separa" con cero caras detectadas, porque no encontraba
indicios de lo contrario. Un medidor que declara exito habiendo medido
nada es peor que uno que falla, porque el numero que da no es
optimista: es inventado. De ahi salio este archivo.

QUE SENAL MANDA EN EL VEREDICTO
───────────────────────────────
Solo `spoofScore`. Las dos espectrales se siguen midiendo e imprimiendo
-poder verlas al lado de la nueva es lo que hace comprobable el ADR
0014- pero estan refutadas y ya no decide nadie con ellas, asi que no
pueden suspender el informe. Hay una prueba dedicada a eso, porque es
justo el tipo de cosa que se rompe sin ruido al tocar el bucle.

`medir_vida.py` solo importa de la biblioteca estandar, asi que esto
corre sin instalar nada, igual que el resto de tests de este servicio.
"""

import contextlib
import io
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from medir_vida import (  # noqa: E402
    aplicar_corte,
    informar,
    mejor_corte,
    sesiones,
)


def bloque(detalle=None, pico=None, spoof=None, sin_cara=0, varias=0, archivos=None):
    """
    Un bloque de resultados de una clase y una variante.

    `archivos` solo hace falta para las pruebas de la mitad reservada,
    que necesitan saber de que sesion viene cada valor. Cuando no se
    pasa, se inventan nombres sin sesion asignada.
    """
    detalle = detalle or []
    pico = pico or []
    spoof = spoof or []
    cuantos = max(len(detalle), len(pico), len(spoof))
    archivos = archivos or [f"img-{i:04d}.jpg" for i in range(cuantos)]

    return {
        "total": cuantos + sin_cara,
        "medidas": cuantos,
        "sin_cara": sin_cara,
        "varias_caras": varias,
        "sin_spoof": max(0, cuantos - len(spoof)) if spoof else 0,
        "archivos": archivos,
        "detalle": detalle,
        "pico": pico,
        "spoof": spoof,
        "archivos_spoof": archivos[: len(spoof)],
    }


def conjunto(partes):
    """Un resultado completo; lo que no se pase queda vacio."""
    base = {
        (clase, variante): bloque()
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
            ataques=[0.10, 0.12, 0.15],
            ataque_es_menor=True,
        )
        self.assertEqual(apcer, 0.0)
        self.assertEqual(bpcer, 0.0)
        self.assertTrue(0.15 < corte < 0.50)

    def test_dos_nubes_identicas_no_se_pueden_separar(self):
        _, apcer, bpcer = mejor_corte(
            reales=[0.4, 0.4, 0.4],
            ataques=[0.4, 0.4, 0.4],
            ataque_es_menor=True,
        )
        self.assertGreater(apcer + bpcer, 0.9)

    def test_reconoce_la_direccion_contraria(self):
        # El ataque da MAS cuando se esperaba que diera menos.
        _, apcer, bpcer = mejor_corte(
            reales=[0.10, 0.12, 0.15],
            ataques=[0.50, 0.52, 0.55],
            ataque_es_menor=True,
        )
        self.assertGreater(apcer + bpcer, 0.9)

    def test_el_corte_por_arriba_tambien_funciona(self):
        corte, apcer, bpcer = mejor_corte(
            reales=[10.0, 12.0, 14.0],
            ataques=[100.0, 120.0, 140.0],
            ataque_es_menor=False,
        )
        self.assertEqual(apcer, 0.0)
        self.assertEqual(bpcer, 0.0)
        self.assertTrue(14.0 < corte < 100.0)

    def test_sin_datos_no_hay_corte(self):
        self.assertIsNone(mejor_corte([], [0.1], True))
        self.assertIsNone(mejor_corte([0.1], [], True))


class AplicarCorte(unittest.TestCase):
    """
    Un corte YA elegido, aplicado a datos que no lo eligieron.

    Es la mitad que le faltaba al medidor: `mejor_corte` siempre queda
    bonito porque elige sabiendo las respuestas.
    """

    def test_cuenta_los_dos_errores_por_separado(self):
        # Corte en 0.6, el ataque da menos. Un ataque en 0.9 pasa, y una
        # cara real en 0.2 se rechaza.
        apcer, bpcer = aplicar_corte(
            reales=[0.9, 0.8, 0.2, 0.7],
            ataques=[0.1, 0.9, 0.2, 0.3],
            corte=0.6,
            ataque_es_menor=True,
        )
        self.assertAlmostEqual(apcer, 0.25)
        self.assertAlmostEqual(bpcer, 0.25)

    def test_el_sentido_del_corte_importa(self):
        # Los mismos numeros con el sentido cambiado dan lo contrario.
        arriba = aplicar_corte([0.9], [0.1], 0.5, ataque_es_menor=True)
        abajo = aplicar_corte([0.9], [0.1], 0.5, ataque_es_menor=False)
        self.assertEqual(arriba, (0.0, 0.0))
        self.assertEqual(abajo, (1.0, 1.0))


class Sesiones(unittest.TestCase):
    """
    Las tandas de captura se detectan por los huecos entre disparos.

    Dentro de una tanda las capturas van separadas por segundos; entre
    tandas, por minutos. Importa porque un corte que solo funciona
    dentro de su sesion ha aprendido la luz de esa tarde, no el ataque.
    """

    def _manifiesto(self, filas):
        import json
        import tempfile

        carpeta = Path(tempfile.mkdtemp())
        (carpeta / "manifiesto.jsonl").write_text(
            "\n".join(
                json.dumps({"archivo": a, "capturadoEn": t}) for a, t in filas
            ),
            encoding="utf-8",
        )
        return carpeta

    def test_un_hueco_largo_abre_una_sesion_nueva(self):
        carpeta = self._manifiesto([
            ("a.jpg", "2026-09-13T23:40:44Z"),
            ("b.jpg", "2026-09-13T23:40:50Z"),
            ("c.jpg", "2026-09-14T00:05:32Z"),
        ])
        reparto = sesiones(carpeta)
        self.assertEqual(reparto["a.jpg"], 1)
        self.assertEqual(reparto["b.jpg"], 1)
        self.assertEqual(reparto["c.jpg"], 2)

    def test_sin_manifiesto_no_se_inventa_un_reparto(self):
        # Devolver {} hace que el informe DIGA que no pudo comprobarlo.
        # Inventar una sesion unica haria que se saltara la
        # comprobacion en silencio, que es la forma de fallar que este
        # archivo existe para evitar.
        import tempfile

        self.assertEqual(sesiones(Path(tempfile.mkdtemp())), {})


class Veredicto(unittest.TestCase):
    """El codigo de salida es el veredicto, y tiene tres valores."""

    @staticmethod
    def _veredicto(resultados, reparto=None):
        """
        Ejecuta el informe y devuelve (codigo, texto).

        La salida se CAPTURA, y no solo para no llenar la consola de
        informes: el script dibuja recuadros con caracteres unicode, y
        una consola de Windows en cp1252 revienta al imprimirlos. Dentro
        del contenedor eso no pasa, pero estos tests corren en el host.
        """
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            codigo = informar(resultados, reparto)
        return codigo, buffer.getvalue()

    def test_cero_medidas_NO_es_exito(self):
        # La regresion que motivo este archivo.
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(sin_cara=8),
                ("pantalla", "terminal"): bloque(sin_cara=8),
            })
        )
        self.assertEqual(salida, 2, "cero medidas tiene que ser un error")
        self.assertIn("NO SE PUDO MEDIR NADA", texto)

    def test_la_senal_que_decide_al_reves_da_veredicto_negativo(self):
        # `spoofScore` es la probabilidad de cara real: si la pantalla
        # puntua MAS que la cara, algo esta al reves de arriba abajo.
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(spoof=[0.10, 0.12, 0.15]),
                ("pantalla", "terminal"): bloque(spoof=[0.90, 0.92, 0.95]),
            })
        )
        self.assertEqual(salida, 1)
        # El informe tiene que DECIR que va al reves, no solo suspender.
        self.assertIn("AL REVES", texto)

    def test_la_senal_que_decide_separando_da_veredicto_positivo(self):
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(spoof=[0.98, 0.99, 0.78]),
                ("pantalla", "terminal"): bloque(spoof=[0.01, 0.12, 0.53]),
            })
        )
        self.assertEqual(salida, 0)
        self.assertNotIn("AL REVES", texto)

    def test_separacion_mala_aunque_vaya_en_la_direccion_correcta(self):
        # Las nubes se solapan: la direccion es la buena pero el mejor
        # corte posible se sigue equivocando demasiado.
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(spoof=[0.40, 0.42, 0.44]),
                ("pantalla", "terminal"): bloque(spoof=[0.39, 0.41, 0.43]),
            })
        )
        self.assertEqual(salida, 1)
        self.assertIn("INSERVIBLE", texto)

    def test_las_senales_REFUTADAS_no_pueden_suspender_el_informe(self):
        # Las dos espectrales en su peor version -apuntando al reves y
        # sin separar- junto a una `spoofScore` que separa limpiamente.
        # El veredicto lo da la que decide.
        #
        # Sin esta prueba, volver a contar las viejas dejaria el medidor
        # en rojo permanente y nadie sabria si es por la senal nueva o
        # por el recuerdo de la vieja.
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(
                    detalle=[0.10, 0.11, 0.12],
                    pico=[500.0, 510.0, 520.0],
                    spoof=[0.98, 0.99, 0.78],
                ),
                ("pantalla", "terminal"): bloque(
                    detalle=[0.90, 0.91, 0.92],
                    pico=[10.0, 11.0, 12.0],
                    spoof=[0.01, 0.12, 0.53],
                ),
            })
        )
        self.assertEqual(salida, 0)
        self.assertIn("AL REVES", texto)
        self.assertIn("informativa, REFUTADA", texto)


class MitadReservada(unittest.TestCase):
    """
    El corte de la primera sesion, aplicado a las siguientes.

    Es la comprobacion que cazo el error anterior: con la sesion 1 sola
    el pico periodico daba 0 % de error, y ese mismo corte aplicado a la
    sesion siguiente dio BPCER 20 % y APCER 25 %.
    """

    @staticmethod
    def _veredicto(resultados, reparto=None):
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            codigo = informar(resultados, reparto)
        return codigo, buffer.getvalue()

    def test_un_corte_que_solo_vale_en_su_sesion_suspende(self):
        # Dentro de la sesion 1 las dos clases estan perfectamente
        # separadas; en la sesion 2 estan cambiadas de sitio. El mejor
        # corte de la 1 se equivoca en todo al aplicarlo a la 2.
        reales = ["r1.jpg", "r2.jpg", "r3.jpg", "r4.jpg"]
        ataques = ["p1.jpg", "p2.jpg", "p3.jpg", "p4.jpg"]
        reparto = {
            "r1.jpg": 1, "r2.jpg": 1, "r3.jpg": 2, "r4.jpg": 2,
            "p1.jpg": 1, "p2.jpg": 1, "p3.jpg": 2, "p4.jpg": 2,
        }
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(
                    spoof=[0.90, 0.95, 0.10, 0.05], archivos=reales
                ),
                ("pantalla", "terminal"): bloque(
                    spoof=[0.10, 0.05, 0.90, 0.95], archivos=ataques
                ),
            }),
            reparto,
        )
        self.assertEqual(salida, 1)
        self.assertIn("NO AGUANTA FUERA DE SU SESION", texto)

    def test_un_corte_que_aguanta_fuera_no_suspende(self):
        reales = ["r1.jpg", "r2.jpg", "r3.jpg", "r4.jpg"]
        ataques = ["p1.jpg", "p2.jpg", "p3.jpg", "p4.jpg"]
        reparto = {
            "r1.jpg": 1, "r2.jpg": 1, "r3.jpg": 2, "r4.jpg": 2,
            "p1.jpg": 1, "p2.jpg": 1, "p3.jpg": 2, "p4.jpg": 2,
        }
        salida, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(
                    spoof=[0.90, 0.95, 0.92, 0.97], archivos=reales
                ),
                ("pantalla", "terminal"): bloque(
                    spoof=[0.10, 0.05, 0.12, 0.07], archivos=ataques
                ),
            }),
            reparto,
        )
        self.assertEqual(salida, 0)
        self.assertNotIn("NO AGUANTA FUERA DE SU SESION", texto)

    def test_sin_reparto_lo_DICE_en_vez_de_darlo_por_bueno(self):
        # Un informe que se salta la comprobacion sin avisar es el mismo
        # fallo que declarar exito habiendo medido cero caras: el
        # veredicto sale en verde y nadie sabe que le falta la mitad.
        _, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(spoof=[0.98, 0.99, 0.78]),
                ("pantalla", "terminal"): bloque(spoof=[0.01, 0.12, 0.53]),
            })
        )
        self.assertIn("NO SE PUDO COMPROBAR", texto)

    def test_con_una_sola_sesion_tampoco_se_da_por_comprobado(self):
        reparto = {f"img-{i:04d}.jpg": 1 for i in range(3)}
        _, texto = self._veredicto(
            conjunto({
                ("real", "terminal"): bloque(spoof=[0.98, 0.99, 0.78]),
                ("pantalla", "terminal"): bloque(spoof=[0.01, 0.12, 0.53]),
            }),
            reparto,
        )
        self.assertIn("NO SE PUDO COMPROBAR", texto)


if __name__ == "__main__":
    unittest.main()
