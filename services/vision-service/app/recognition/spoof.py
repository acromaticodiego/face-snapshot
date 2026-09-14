"""
Deteccion de vida con MiniFASNet: la senal que SI separa.

QUE SUSTITUYE, Y POR QUE HIZO FALTA SUSTITUIRLO
-----------------------------------------------
`liveness.py` mide dos senales espectrales sobre el recorte alineado de
112x112. Se midieron contra un conjunto de ataque real -40 caras y 40
fotos de esas caras en la pantalla de un movil- y NO separan. El detalle
esta en el ADR 0010 y en el 0014; el resumen es que el `pattern_peak`
existia para delatar la rejilla de una pantalla y marcaba MAS ALTO con
la cara real, y que ademas correlaciona +0.39 con el ancho de la cara:
mide a que distancia estas de la camara tanto como si hay una pantalla.

Este modulo es el reemplazo, y a diferencia del anterior viene con
numeros de un ataque de verdad (80 imagenes, dos sesiones, la webcam del
despliegue), sin haber ajustado ningun umbral sobre ellas:

    BPCER   0.0 %   40/40 caras reales aceptadas
    APCER   2.6 %   37/38 ataques rechazados
    margen  peor cara real 0.777 · mejor ataque 0.539
    coste   22.7 ms, frente a los ~740 del detector

SIGUE SIN JUZGAR, Y ESO NO CAMBIA
---------------------------------
Devuelve un NUMERO, igual que `liveness.py`: la probabilidad de que el
rostro sea una cara real delante de la camara. Quien decide que hacer
con el es el Access Service, porque un umbral de seguridad es politica y
este servicio no tiene politica (ADR 0002).

POR QUE SOBRE EL FRAME ORIGINAL Y NO SOBRE EL RECORTE ALINEADO
--------------------------------------------------------------
Es justo la equivocacion que hundio la senal anterior. Entre el sensor y
el recorte de 112 hay dos reducciones sin filtro antialias, y lo que
delata una recaptura no sobrevive a eso. Aqui se recorta del frame tal
como llego, con el margen que cada modelo espera.

DOS MODELOS, NO UNO
-------------------
El repositorio de origen distribuye dos pesos entrenados con escalas de
recorte distintas -2.7 y 4.0 veces la caja del rostro- y suma sus
probabilidades. Ven cantidades distintas de contexto alrededor de la
cara: el borde de un movil o el marco de una foto impresa caen dentro de
la escala ancha y fuera de la estrecha. Se usan los dos porque es la
configuracion que se evaluo; quitar uno cambiaria el numero y los
resultados de arriba dejarian de aplicar.

LA TRAMPA DEL /255
------------------
Estos modelos esperan la entrada en 0-255, NO en [0,1]. Alimentados mal
NO fallan de forma visible: responden lo mismo a una cara, a ruido puro
y a una imagen negra. Esta contado con detalle, y con lo que costo, en
`modelos/antispoof/PROCEDENCIA.md`. El test
`test_spoof.py::test_la_entrada_no_se_normaliza` existe para que no
vuelva a colarse.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Callable

import numpy as np

from app.core.errors import ModelNotReadyError
from app.core.logging import get_logger
from app.recognition.minifasnet.generate_patches import CropImage

logger = get_logger(__name__)

# Lado de la entrada de los dos modelos. Esta en el nombre del archivo
# (`..._80x80_...`) y determina el nucleo de la ultima convolucion.
_INPUT_SIZE = 80

# Las TRES salidas, deducidas midiendo: el repositorio de origen no las
# documenta. Sobre el conjunto de ataque de este proyecto la clase 1
# separa las caras reales y la 2 las pantallas, sin solapamiento.
CLASE_IMPRESO = 0
CLASE_CARA_REAL = 1
CLASE_PANTALLA = 2

_NOMBRES_DE_CLASE = {
    CLASE_IMPRESO: "impreso",
    CLASE_CARA_REAL: "cara_real",
    CLASE_PANTALLA: "pantalla",
}


@dataclass(frozen=True)
class _Modelo:
    """Un peso con la escala de recorte con la que fue entrenado."""

    archivo: str
    escala: float
    constructor_nombre: str


# La escala NO es un parametro ajustable: viene en el nombre del archivo
# porque es con la que se entreno ese peso concreto. Cambiarla le da al
# modelo una entrada distinta de la que vio entrenando.
_MODELOS = (
    _Modelo("2.7_80x80_MiniFASNetV2.pth", 2.7, "MiniFASNetV2"),
    _Modelo("4_0_0_80x80_MiniFASNetV1SE.pth", 4.0, "MiniFASNetV1SE"),
)


@dataclass(frozen=True)
class SpoofEvidence:
    """
    Lo que el modelo vio. NO es un veredicto.

    `real_score` es la probabilidad media de la clase «cara real» entre
    los dos modelos, en [0, 1]. Mas alto = mas parece una persona
    delante de la camara.
    """

    real_score: float

    #: Clase mas probable segun la suma de los dos modelos. Solo viaja a
    #: la traza: sirve para investigar una sospecha -«el modelo dijo
    #: pantalla»- y no forma parte del contrato con el Face Service.
    label: int

    @property
    def label_name(self) -> str:
        return _NOMBRES_DE_CLASE.get(self.label, str(self.label))


class SpoofDetector:
    """
    Los dos MiniFASNet, cargados una vez al arrancar.

    Se carga en el arranque por el mismo motivo que ArcFace: cargarlos
    por peticion costaria cientos de milisegundos sobre un presupuesto
    de frame que ya esta ajustado.
    """

    def __init__(self, models_dir: Path):
        self._dir = Path(models_dir)
        self._cargados: list[tuple[_Modelo, object]] = []
        self._cropper = CropImage()

    @property
    def is_ready(self) -> bool:
        return len(self._cargados) == len(_MODELOS)

    @property
    def name(self) -> str:
        return "MiniFASNet (V2 @2.7 + V1SE @4.0)"

    @property
    def version(self) -> str:
        # Cambiar de pesos cambia la escala del numero, y con ella el
        # significado de `LIVENESS_MIN_SPOOF_SCORE`. Si esto sube, hay
        # que volver a medir antes de tocar el umbral.
        return "1"

    def load(self) -> None:
        """
        Carga los dos pesos. Si falta uno, el servicio NO arranca.

        Es deliberado que reviente aqui en vez de seguir sin puntuar.
        Un Vision Service que arranca pero no mide la vida deja al Access
        Service sin evidencia, y sin evidencia no hay sospecha: el
        sistema se quedaria sin deteccion de vida en silencio, que es
        justo el modo de fallo que un camino critico de seguridad no
        puede permitirse. Un contenedor que no levanta se ve; una
        proteccion apagada, no.

        El interruptor para no mirar existe, pero esta donde vive la
        politica: `LIVENESS_MODE=OFF` en el Access Service.
        """
        if self.is_ready:
            return

        import torch

        from app.recognition.minifasnet import MiniFASNet as arquitectura

        # (80 + 15) // 16 = 5. Es como lo calcula el repositorio de
        # origen a partir del tamano de entrada del nombre del archivo.
        kernel = ((_INPUT_SIZE + 15) // 16, (_INPUT_SIZE + 15) // 16)

        cargados: list[tuple[_Modelo, object]] = []
        for modelo in _MODELOS:
            ruta = self._dir / modelo.archivo
            if not ruta.exists():
                raise ModelNotReadyError(
                    f"Falta el modelo de deteccion de vida: {ruta}. "
                    "Los pesos van versionados en modelos/antispoof/; "
                    "ver su PROCEDENCIA.md."
                )

            constructor: Callable = getattr(arquitectura, modelo.constructor_nombre)
            red = constructor(conv6_kernel=kernel)

            # `weights_only=True` no es ceremonia: un .pth es un pickle,
            # y deserializar uno completo ejecuta codigo arbitrario. Se
            # cargan tensores y nada mas.
            estado = torch.load(str(ruta), map_location="cpu", weights_only=True)

            # Los pesos se guardaron desde un `DataParallel`, que
            # prefija cada clave con `module.`. Sin quitarlo,
            # `load_state_dict` no encuentra ni una sola coincidencia.
            if next(iter(estado)).startswith("module."):
                estado = {k[len("module.") :]: v for k, v in estado.items()}

            red.load_state_dict(estado)

            # eval() apaga el dropout y hace que BatchNorm use las
            # estadisticas guardadas en vez de las del lote. Sin esto un
            # lote de una sola imagen se normaliza contra si mismo y la
            # salida no se parece a nada.
            red.eval()
            cargados.append((modelo, red))

        self._cargados = cargados
        logger.info(
            "antispoof_cargado",
            modelos=[m.archivo for m, _ in cargados],
            directorio=str(self._dir),
        )

    def score(
        self, image_bgr: np.ndarray, bbox_xywh: tuple[int, int, int, int]
    ) -> SpoofEvidence | None:
        """
        Puntua un rostro del frame ORIGINAL.

        `bbox_xywh` es la caja del detector en coordenadas de
        `image_bgr`, no del recorte alineado.

        DEVUELVE None SI NO SE PUDO MEDIR, Y NUNCA 0.0
        ──────────────────────────────────────────────
        Un fallo midiendo no puede tumbar el frame, igual que en el
        resto del pipeline. Pero aqui el valor neutro no es cero: cero
        es «esto es un ataque segurisimo», y en modo HARD dejaria a una
        persona real en la calle por un error de codigo. La ausencia de
        evidencia viaja como ausencia, y el Access Service ya sabe que
        sin evidencia no hay sospecha.
        """
        if not self._cargados:
            raise ModelNotReadyError("El modelo de deteccion de vida no esta cargado")

        if image_bgr is None or image_bgr.size == 0:
            return None

        try:
            import torch
            import torch.nn.functional as F

            x, y, w, h = (int(v) for v in bbox_xywh)
            if w <= 0 or h <= 0:
                return None

            acumulado = np.zeros(3, dtype=np.float64)

            for modelo, red in self._cargados:
                recorte = self._cropper.crop(
                    image_bgr,
                    [x, y, w, h],
                    modelo.escala,
                    _INPUT_SIZE,
                    _INPUT_SIZE,
                    True,
                )

                # HWC -> CHW, y a float SIN dividir entre 255. Ver el
                # encabezado de este modulo: dividir aqui no rompe nada
                # de forma visible, solo deja al modelo ciego.
                tensor = torch.from_numpy(
                    np.ascontiguousarray(recorte.transpose(2, 0, 1))
                ).float().unsqueeze(0)

                with torch.no_grad():
                    salida = red(tensor)
                    acumulado += F.softmax(salida, dim=1).numpy()[0].astype(np.float64)

            # Media entre los dos modelos: asi el numero sigue siendo una
            # probabilidad en [0, 1] y no depende de cuantos modelos haya.
            probabilidades = acumulado / len(self._cargados)

            return SpoofEvidence(
                real_score=round(float(probabilidades[CLASE_CARA_REAL]), 4),
                label=int(np.argmax(probabilidades)),
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning("fallo_al_puntuar_vida", error=str(exc))
            return None
