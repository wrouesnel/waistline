/*
  Copyright 2026 Will Rouesnel

  This file is part of Waistline.

  Waistline is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  Waistline is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with app.  If not, see <http://www.gnu.org/licenses/>.
*/

package com.waistline.paddleocr;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.net.Uri;
import android.util.Size;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageAnalysis;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.ImageProxy;
import androidx.camera.core.Preview;
import androidx.camera.core.UseCaseGroup;
import androidx.camera.core.ViewPort;
import androidx.camera.core.resolutionselector.ResolutionSelector;
import androidx.camera.core.resolutionselector.ResolutionStrategy;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.google.common.util.concurrent.ListenableFuture;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Camera preview shown behind the (transparent) WebView. Frames are read with the OCR engine
 * and the results are sent to JavaScript, which draws what was found over the preview.
 *
 * Preview, analysis and capture share the preview's viewport, so analysis coordinates scale
 * directly onto the visible preview and captured photos show what was on screen.
 */
class LiveScanner {

    private static final int LIVE_DET_LIMIT = 640;
    private static final int MAX_LIVE_READ = 30;

    private final Activity activity;
    private final View webView;
    private volatile OcrEngine engine;   // set once the models have loaded
    private final ExecutorService analysisExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService readExecutor = Executors.newSingleThreadExecutor();

    private PreviewView previewView;
    private ProcessCameraProvider provider;
    private ImageCapture capture;
    private CallbackContext frames;
    private volatile boolean running;
    private volatile boolean reading;
    private volatile boolean capturing;  // frames aren't read while a photo is being taken
    private final ExecutorService captureExecutor = Executors.newSingleThreadExecutor();

    LiveScanner(Activity activity, View webView) {
        this.activity = activity;
        this.webView = webView;
    }

    // The camera starts straight away; frames are only read once the models have loaded
    void setEngine(OcrEngine engine) {
        this.engine = engine;
    }

    // Runs on the UI thread
    void start(CallbackContext callback) {
        frames = callback;
        running = true;

        previewView = new PreviewView(activity);
        previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);
        previewView.setScaleType(PreviewView.ScaleType.FILL_CENTER);
        ViewGroup root = (ViewGroup) webView.getParent();
        FrameLayout.LayoutParams webParams = (FrameLayout.LayoutParams) webView.getLayoutParams();
        FrameLayout.LayoutParams params = new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT);
        params.setMargins(webParams.leftMargin, webParams.topMargin, webParams.rightMargin, webParams.bottomMargin);
        root.addView(previewView, 0, params);
        webView.setBackgroundColor(Color.TRANSPARENT);

        ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(activity);
        future.addListener(() -> {
            try {
                provider = future.get();
                // The viewport is only known once the preview has been laid out
                previewView.post(this::bind);
            } catch (Exception e) {
                sendError(e);
            }
        }, ContextCompat.getMainExecutor(activity));
    }

    private void bind() {
        if (!running || provider == null)
            return;
        try {
            ResolutionSelector analysisResolution = new ResolutionSelector.Builder()
                .setResolutionStrategy(new ResolutionStrategy(new Size(1280, 960),
                    ResolutionStrategy.FALLBACK_RULE_CLOSEST_HIGHER_THEN_LOWER))
                .build();

            Preview preview = new Preview.Builder().build();
            preview.setSurfaceProvider(previewView.getSurfaceProvider());

            ImageAnalysis analysis = new ImageAnalysis.Builder()
                .setResolutionSelector(analysisResolution)
                .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST)
                .setOutputImageFormat(ImageAnalysis.OUTPUT_IMAGE_FORMAT_RGBA_8888)
                .build();
            analysis.setAnalyzer(analysisExecutor, this::analyse);

            capture = new ImageCapture.Builder()
                .setCaptureMode(ImageCapture.CAPTURE_MODE_MAXIMIZE_QUALITY)
                .build();

            UseCaseGroup.Builder group = new UseCaseGroup.Builder()
                .addUseCase(preview)
                .addUseCase(analysis)
                .addUseCase(capture);
            ViewPort viewPort = previewView.getViewPort();
            if (viewPort != null)
                group.setViewPort(viewPort);

            provider.unbindAll();
            provider.bindToLifecycle((LifecycleOwner) activity, CameraSelector.DEFAULT_BACK_CAMERA, group.build());

            JSONObject started = new JSONObject();
            started.put("event", "started");
            send(started);
        } catch (Exception e) {
            sendError(e);
        }
    }

    // Every frame: find the text boxes and send them straight away, so the outlines follow the
    // camera. Reading the text is slower, so it runs on its own thread for the latest frame
    // whenever it is free.
    private void analyse(ImageProxy image) {
        try {
            OcrEngine engine = this.engine;
            if (!running || capturing || engine == null)
                return;
            // Crop to the viewport and turn upright
            Bitmap frame = image.toBitmap();
            Rect crop = image.getCropRect();
            int rotation = image.getImageInfo().getRotationDegrees();
            Matrix m = new Matrix();
            m.postRotate(rotation);
            Bitmap upright = Bitmap.createBitmap(frame, crop.left, crop.top, crop.width(), crop.height(), m, true);

            List<OcrEngine.Box> boxes = engine.detectBoxes(upright, LIVE_DET_LIMIT);
            JSONObject event = new JSONObject();
            event.put("event", "boxes");
            event.put("width", upright.getWidth());
            event.put("height", upright.getHeight());
            event.put("boxes", OcrEngine.boxesJson(boxes));
            if (running)
                send(event);

            if (!reading && !boxes.isEmpty()) {
                reading = true;
                List<OcrEngine.Box> toRead = tableCandidates(boxes, upright.getWidth(), upright.getHeight());
                readExecutor.execute(() -> {
                    try {
                        JSONArray lines = new JSONArray();
                        engine.readBoxes(upright, toRead, (batch) -> {
                            for (int i = 0; i < batch.length(); i++)
                                lines.put(batch.get(i));
                        });
                        JSONObject result = new JSONObject();
                        result.put("event", "frame");
                        result.put("width", upright.getWidth());
                        result.put("height", upright.getHeight());
                        result.put("lines", lines);
                        if (running)
                            send(result);
                    } catch (Throwable e) {
                        sendError(e);
                    } finally {
                        reading = false;
                    }
                });
            }
        } catch (Throwable e) {
            sendError(e);
        } finally {
            image.close();
        }
    }

    // To keep the live view quick, read only boxes that could be part of a table: not wide
    // paragraphs of text (like ingredients), and at most the MAX_LIVE_READ nearest the centre
    private static List<OcrEngine.Box> tableCandidates(List<OcrEngine.Box> boxes, int width, int height) {
        List<OcrEngine.Box> out = new ArrayList<>();
        for (OcrEngine.Box b : boxes) {
            if (b.w < width * 0.6f)
                out.add(b);
        }
        float cx = width / 2f;
        float cy = height / 2f;
        out.sort((a, b) -> Float.compare(
            (a.cx - cx) * (a.cx - cx) + (a.cy - cy) * (a.cy - cy),
            (b.cx - cx) * (b.cx - cx) + (b.cy - cy) * (b.cy - cy)));
        return out.size() > MAX_LIVE_READ ? new ArrayList<>(out.subList(0, MAX_LIVE_READ)) : out;
    }

    void capture(CallbackContext callback) {
        if (capture == null) {
            callback.error("Camera is not ready");
            return;
        }
        File file = new File(activity.getCacheDir(), "nutrition-label-" + System.currentTimeMillis() + ".jpg");
        ImageCapture.OutputFileOptions output = new ImageCapture.OutputFileOptions.Builder(file).build();
        // Its own thread, so taking the photo doesn't wait for a frame being read
        capturing = true;
        capture.takePicture(output, captureExecutor, new ImageCapture.OnImageSavedCallback() {
            @Override
            public void onImageSaved(ImageCapture.OutputFileResults results) {
                capturing = false;
                callback.success(Uri.fromFile(file).toString());
            }

            @Override
            public void onError(ImageCaptureException e) {
                capturing = false;
                callback.error("Capture failed: " + e.getMessage());
            }
        });
    }

    // Runs on the UI thread
    void stop() {
        running = false;
        if (provider != null)
            provider.unbindAll();
        provider = null;
        capture = null;
        if (previewView != null) {
            ((ViewGroup) previewView.getParent()).removeView(previewView);
            previewView = null;
        }
        webView.setBackgroundColor(Color.WHITE);
        if (frames != null) {
            try {
                JSONObject stopped = new JSONObject();
                stopped.put("event", "stopped");
                frames.sendPluginResult(new PluginResult(PluginResult.Status.OK, stopped));
            } catch (Exception ignored) {
            }
            frames = null;
        }
    }

    void shutdown() {
        analysisExecutor.shutdown();
        readExecutor.shutdown();
        captureExecutor.shutdown();
    }

    private void send(JSONObject message) {
        CallbackContext cb = frames;
        if (cb == null)
            return;
        PluginResult result = new PluginResult(PluginResult.Status.OK, message);
        result.setKeepCallback(true);
        cb.sendPluginResult(result);
    }

    private void sendError(Throwable e) {
        try {
            JSONObject error = new JSONObject();
            error.put("event", "error");
            error.put("message", e.getClass().getSimpleName() + ": " + e.getMessage());
            send(error);
        } catch (Exception ignored) {
        }
    }
}
