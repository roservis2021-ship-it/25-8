# EchoDrift — VST3 Delay Plugin

Plugin de efecto de audio (delay/echo estéreo) construido con [JUCE](https://juce.com/), compatible con FL Studio (formato VST3) en Windows y macOS.

## Parámetros

| Parámetro | Rango | Descripción |
|---|---|---|
| **Time** | 1–2000 ms | Tiempo de retardo del eco |
| **Feedback** | 0–95% | Cuántas repeticiones se generan |
| **Mix** | 0–100% | Balance entre señal seca (dry) y con eco (wet) |
| **Tone** | 200–18000 Hz | Filtro paso-bajo en el lazo de feedback (oscurece los repeats, como un delay analógico) |

## Estado de este proyecto

El código fuente está completo y **ya se compiló y verificó con éxito en Linux** dentro de este contenedor (genera un `.vst3` funcional para Linux), lo que confirma que el C++ es correcto y compila sin errores. FL Studio en Windows/macOS necesita el binario nativo de esa plataforma, así que el paso final de compilación debes hacerlo tú en tu propia máquina — no es posible generar un `.dll`/`.vst3` de Windows desde este entorno Linux.

## Cómo compilarlo en tu ordenador

### Requisitos

- **Windows**: [Visual Studio 2022](https://visualstudio.microsoft.com/) (con "Desktop development with C++") + [CMake](https://cmake.org/download/)
- **macOS**: Xcode + CMake (`brew install cmake`)
- Conexión a internet (CMake descarga JUCE automáticamente la primera vez)

### Pasos (Windows y macOS son iguales)

```bash
cd vst-plugin
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release --target EchoDrift_VST3
```

Esto descarga JUCE 8.0.4 automáticamente vía `FetchContent` y compila el plugin. El resultado queda en:

- **Windows**: `build/EchoDrift_artefacts/Release/VST3/EchoDrift.vst3`
- **macOS**: `build/EchoDrift_artefacts/Release/VST3/EchoDrift.vst3`

### Instalar en FL Studio

Copia (o crea un acceso directo a) la carpeta/archivo `EchoDrift.vst3` en tu carpeta de plugins VST3:

- **Windows**: `C:\Program Files\Common Files\VST3\`
- **macOS**: `/Library/Audio/Plug-Ins/VST3/`

Luego, en FL Studio: `Options → Manage Plugins → Find Plugins (Scan)`. EchoDrift aparecerá en el buscador de plugins (categoría Fx/Delay), listo para insertarse en cualquier canal de mixer.

### Probarlo sin FL Studio (Standalone)

También se genera una versión standalone que puedes ejecutar directamente para probar el sonido sin abrir un DAW:

```bash
cmake --build build --config Release --target EchoDrift_Standalone
```

El ejecutable queda en `build/EchoDrift_artefacts/Release/Standalone/`.

## Estructura del proyecto

```
vst-plugin/
├── CMakeLists.txt          # configuración de build (JUCE + formato VST3)
└── Source/
    ├── PluginProcessor.h/.cpp   # DSP: delay line estéreo, feedback, filtro de tono
    └── PluginEditor.h/.cpp      # GUI: 4 knobs (Time, Feedback, Mix, Tone)
```

## Personalización

Todos los parámetros están definidos en `createParameterLayout()` en `PluginProcessor.cpp`. Puedes ajustar rangos, valores por defecto, o añadir nuevos parámetros (p. ej. ping-pong estéreo, saturación) siguiendo el mismo patrón con `juce::AudioProcessorValueTreeState`.
