# cordova-plugin-paddle-ocr

On-device text recognition for Waistline's nutrition label scanner. It runs PaddleOCR's PP-OCRv5
mobile text detection and Latin-script recognition models with ONNX Runtime. Nothing leaves the
device.

```js
PaddleOcr.isAvailable()                  // Promise<boolean>: true on Android 7.0+
PaddleOcr.recognize(uri, {crop: {x0, y0, x1, y1}, preview: 1600})
// Promise<{width, height, lines: [{text, conf, cx, cy, w, h, angle}], preview, timing}>
PaddleOcr.cropImage(uri, {cx, cy, w, h, angle}, maxSide)   // Promise<JPEG data URL>, straightened

PaddleOcr.startPreview(onEvent, onError) // live camera preview behind the WebView
// onEvent({event: "started" | "frame" | "error" | "stopped", ...}); frames are like recognize()
PaddleOcr.capture()                      // Promise<file:// URI> of a full resolution photo
PaddleOcr.stopPreview()
```

`uri` can be a `file://`, `content://` or `data:` URI. EXIF orientation is applied. Coordinates
are in pixels of the (cropped) image and `angle` is in radians. `preview` asks for a JPEG data
URL of the whole image, at most that many pixels on its longest side.

The live preview uses CameraX. It is added behind the WebView, so the page must be transparent
where the camera should show. Preview, analysis and capture share the preview's viewport, so frame
coordinates scale directly onto the screen and photos show what was on screen. The camera is
released when the app is paused; call `startPreview` again on resume. The plugin asks for the
camera permission when the preview starts.

## Models

| File | Source | Licence |
|---|---|---|
| `models/PP-OCRv5_mobile_det.onnx` | [PaddlePaddle/PP-OCRv5_mobile_det_onnx](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx) `inference.onnx` | Apache-2.0 |
| `models/latin_PP-OCRv5_mobile_rec.onnx` | [PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx](https://huggingface.co/PaddlePaddle/latin_PP-OCRv5_mobile_rec_onnx) `inference.onnx` | Apache-2.0 |
| `models/latin_PP-OCRv5_mobile_rec_dict.txt` | `PostProcess.character_dict` from the same repository's `inference.yml` | Apache-2.0 |

SHA-256:

```
a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d  PP-OCRv5_mobile_det.onnx
7888113072263cb471b93f66dd5e2ad70548dc526fa1ace760d0d973dd121498  latin_PP-OCRv5_mobile_rec.onnx
ccbcc45730b3fbbd9050c5bc74db6a99067141ef1035e3d14889a84a6b9b1aff  latin_PP-OCRv5_mobile_rec_dict.txt
```

## Runtime

[ONNX Runtime](https://github.com/microsoft/onnxruntime) for Android (MIT), from Maven Central,
and [CameraX](https://developer.android.com/jetpack/androidx/releases/camera) (Apache-2.0). They
need Android 7.0 (API 24) and 6.0 (API 23); on older versions `isAvailable()` resolves to `false`
and the plugin never loads their classes. Its telemetry initializer is removed from the manifest
and telemetry is switched off when the engine starts.
