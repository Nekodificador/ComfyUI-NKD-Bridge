# Instalar NKD Comfy Bridge

Se instalan dos piezas: un pack de nodos dentro de ComfyUI y un panel pequeño dentro de Photoshop. Son unos cinco minutos. Sigue los pasos en orden y no te saltes las comprobaciones: cada una te confirma que el paso anterior salió bien.

## Qué necesitas

- **Photoshop 2023 (versión 24.4) o posterior.** Para mirarlo: en Photoshop, `Ayuda > Acerca de Photoshop`.
- **ComfyUI** instalado y funcionando (lo abres en el navegador y puedes lanzar un workflow).
- **La app de Creative Cloud**, la misma con la que instalaste Photoshop. Es la que instala el panel.

## Paso 1. Instala los nodos en ComfyUI

**Opción A: con ComfyUI Manager (la más fácil)**

1. Abre ComfyUI en el navegador.
2. Pulsa **Manager** y luego **Custom Nodes Manager**.
3. Busca `NKD Comfy Bridge` y pulsa **Install**.
4. Cuando termine, pulsa **Restart** y espera a que ComfyUI vuelva a cargar.

**Opción B: a mano**

1. Abre una terminal en tu carpeta `ComfyUI/custom_nodes`.
2. Ejecuta:
   ```bash
   git clone https://github.com/Nekodificador/ComfyUI-NKD-Bridge
   ```
3. Reinicia ComfyUI.

**Comprobación:** haz doble clic en una zona vacía del lienzo de ComfyUI y escribe `Bridge`. Deben salir siete nodos que empiezan por `😺NKD Bridge`. Si no salen, ComfyUI no se reinició o la instalación falló: busca en la consola de ComfyUI una línea roja que mencione `NKD-Bridge`.

## Paso 2. Instala el panel de Photoshop

**En Windows, la vía rápida:** abre la carpeta `ComfyUI/custom_nodes/ComfyUI-NKD-Bridge` y haz doble clic en **`install-photoshop-plugin.bat`**. Se abre una ventana negra, pone `Done` y ya puedes cerrarla.

**En cualquier sistema (Windows o Mac):**

1. En ComfyUI, abre el menú de arriba a la izquierda (el logo de ComfyUI) y entra en **Extensions > NKD Comfy Bridge > Download NKD Comfy Bridge plugin for Photoshop**. Se descarga un fichero `NKD-Comfy-Bridge.ccx` en tu carpeta de Descargas.
2. Haz doble clic en ese fichero. Se abre Creative Cloud y avisa de que el plugin no viene del marketplace de Adobe. Es normal: pulsa **Instalar**.

**Comprobación:** abre (o reinicia) Photoshop. En el menú de arriba entra en **Plugins**. Tiene que aparecer **NKD Comfy Bridge**; púlsalo y se abre el panel.

## Paso 3. Conecta

Con ComfyUI en marcha y su pestaña abierta en el navegador, mira la parte de arriba del panel:

| El panel dice | Qué significa | Qué hacer |
|---|---|---|
| ● Conectado a ComfyUI | Todo bien | Ve al paso 4 |
| ◐ Conectado · abre ComfyUI en el navegador | Photoshop encuentra ComfyUI pero no hay ninguna pestaña abierta | Abre ComfyUI en el navegador. Vale cualquier pestaña: la última en la que hiciste clic es la que ejecuta |
| ○ Sin conexión, reintentando | Photoshop no llega a ComfyUI | ¿Está ComfyUI en marcha? Si no está en `http://127.0.0.1:8188`, pulsa el ⚙ del panel y escribe su dirección (la que ves en la barra del navegador) |

## Paso 4. Tu primera generación

1. En ComfyUI, abre el menú de arriba a la izquierda, **File > Open**, y elige `example_workflows/NKD Bridge - Live SD1.5 LCM.json` dentro de la carpeta `ComfyUI-NKD-Bridge`. (O arrastra el fichero al lienzo de ComfyUI.)
2. El ejemplo usa dos modelos. Si ComfyUI los marca en rojo, descárgalos y elige los tuyos en los dos nodos de carga:
   - un checkpoint de SD 1.5, por ejemplo `v1-5-pruned-emaonly.safetensors`, en `models/checkpoints`
   - el LoRA LCM para SD 1.5, `lcm-lora-sdv1-5.safetensors`, en `models/loras`
3. En Photoshop, crea un documento (1024 × 1024 vale) y pinta unas manchas de color.
4. En el panel, pulsa **Generar**. Verás el progreso en tu pestaña de ComfyUI, y el resultado aparece en el panel y como una capa nueva llamada `NKD Live 1`.
5. Marca **Live** y sigue pintando: se regenera cada vez que paras.
6. Para hacer inpainting, instala también [NKD Basic Tools](https://github.com/Nekodificador/ComfyUI-NKD-Basic-Tools) (desde el ComfyUI Manager), abre `NKD Bridge - Inpaint selection SD1.5 LCM.json`, haz una selección en Photoshop y pulsa **Generar**: solo se rehace la zona seleccionada, y el resultado vuelve a su sitio como la capa `NKD Inpaint 1`. Si tienes Z-Image Turbo, `NKD Bridge - Inpaint selection ZImage Turbo.json` hace lo mismo con un prompt y un slider de denoise en el panel.

## Vincular una capa a un nodo

Un nodo **😺NKD Bridge Input** lee el documento entero por defecto. Cámbialo cuando una parte del workflow tenga que leer siempre la misma capa o grupo.

- En ComfyUI, elige la capa en la lista **Photoshop source** del nodo. O bien,
- en Photoshop, selecciona la capa, abre la pestaña **Entradas y salidas** del panel y pulsa **Usar activa** junto a esa entrada.

El vínculo se guarda con el workflow. Renombrar la capa no lo rompe.

## Si algo falla

| Problema | Solución |
|---|---|
| No aparece **Plugins > NKD Comfy Bridge** | Reinicia Photoshop. Si sigue sin salir, vuelve a instalar y lee el mensaje de la ventana negra |
| Creative Cloud dice que el fichero no es válido | Vuelve a descargar el `.ccx` desde el menú de ComfyUI; uno descargado a medias no se instala |
| El panel sale en blanco | Actualiza Photoshop a la última versión desde Creative Cloud |
| "Abre antes ComfyUI en el navegador" | El puente ejecuta los workflows a través de tu pestaña de ComfyUI, para que puedas verlos. Ábrela |
| Una entrada muestra **!** | La capa de ese nodo ya no existe en este documento. Vuelve a vincularla |
| Generar no hace nada | El workflow necesita al menos un nodo **😺NKD Bridge Output** |
| ComfyUI está en otro ordenador | Pon su dirección en los ajustes ⚙ (por ejemplo `http://192.168.1.20:8188`) y arranca ComfyUI con `--listen` |

---

[← Todos los nodos de 😺NKD Comfy Bridge](../README.md)
