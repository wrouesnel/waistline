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

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;

import org.apache.cordova.CallbackContext;
import org.apache.cordova.CordovaPlugin;
import org.apache.cordova.PluginResult;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public class PaddleOcrPlugin extends CordovaPlugin {

    // ONNX Runtime requires API 24. This class must not touch its classes on older versions.
    private static final int MIN_SDK = 24;
    private static final int CAMERA_REQUEST = 7301;

    private Object engine;  // OcrEngine, created on first use
    private Object scanner; // LiveScanner while the live preview is running
    private CallbackContext pendingPreview;

    @Override
    public boolean execute(String action, JSONArray args, CallbackContext callbackContext) throws JSONException {
        if ("isAvailable".equals(action)) {
            callbackContext.success(Build.VERSION.SDK_INT >= MIN_SDK ? 1 : 0);
            return true;
        }
        if (Build.VERSION.SDK_INT < MIN_SDK) {
            callbackContext.error("Text recognition needs Android 7.0 or newer");
            return true;
        }

        switch (action) {
            case "recognize": {
                final String uri = args.getString(0);
                final JSONObject options = args.optJSONObject(1);
                final boolean stream = options != null && options.optBoolean("stream", false);
                cordova.getThreadPool().execute(() -> {
                    try {
                        OcrEngine.Listener listener = stream ? new OcrEngine.Listener() {
                            @Override
                            public void onImage(JSONObject image) throws Exception {
                                image.put("event", "image");
                                sendProgress(callbackContext, image);
                            }

                            @Override
                            public void onBoxes(JSONArray boxes) throws Exception {
                                JSONObject event = new JSONObject();
                                event.put("event", "boxes");
                                event.put("boxes", boxes);
                                sendProgress(callbackContext, event);
                            }

                            @Override
                            public void onLines(JSONArray lines) throws Exception {
                                JSONObject event = new JSONObject();
                                event.put("event", "lines");
                                event.put("lines", lines);
                                sendProgress(callbackContext, event);
                            }
                        } : null;
                        JSONObject result = getEngine().recognize(uri, options, listener);
                        result.put("event", "done");
                        callbackContext.success(result);
                    } catch (Throwable e) {
                        callbackContext.error(e.getClass().getSimpleName() + ": " + e.getMessage());
                    }
                });
                return true;
            }
            case "cropImage": {
                final String uri = args.getString(0);
                final JSONObject box = args.getJSONObject(1);
                final int maxSide = args.optInt(2, 2000);
                cordova.getThreadPool().execute(() -> {
                    try {
                        callbackContext.success(getEngine().cropImage(uri, box, maxSide));
                    } catch (Throwable e) {
                        callbackContext.error(e.getClass().getSimpleName() + ": " + e.getMessage());
                    }
                });
                return true;
            }
            case "startPreview":
                if (cordova.hasPermission(Manifest.permission.CAMERA)) {
                    startPreview(callbackContext);
                } else {
                    pendingPreview = callbackContext;
                    cordova.requestPermission(this, CAMERA_REQUEST, Manifest.permission.CAMERA);
                }
                return true;
            case "capture":
                cordova.getActivity().runOnUiThread(() -> {
                    if (scanner == null)
                        callbackContext.error("Preview is not running");
                    else
                        ((LiveScanner) scanner).capture(callbackContext);
                });
                return true;
            case "stopPreview":
                cordova.getActivity().runOnUiThread(() -> {
                    stopPreview();
                    callbackContext.success();
                });
                return true;
            default:
                return false;
        }
    }

    @Override
    public void onRequestPermissionResult(int requestCode, String[] permissions, int[] grantResults) {
        if (requestCode != CAMERA_REQUEST || pendingPreview == null)
            return;
        CallbackContext callback = pendingPreview;
        pendingPreview = null;
        if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED)
            startPreview(callback);
        else
            callback.error("Camera permission denied");
    }

    private void startPreview(CallbackContext callbackContext) {
        // Start the camera straight away, so a photo can be taken at once; the models load in
        // the background and frames are read once they are ready
        cordova.getActivity().runOnUiThread(() -> {
            stopPreview();
            LiveScanner live = new LiveScanner(cordova.getActivity(), webView.getView());
            scanner = live;
            live.start(callbackContext);
            cordova.getThreadPool().execute(() -> {
                try {
                    live.setEngine(getEngine());
                } catch (Throwable e) {
                    callbackContext.error(e.getClass().getSimpleName() + ": " + e.getMessage());
                }
            });
        });
    }

    private void stopPreview() {
        if (scanner != null) {
            LiveScanner live = (LiveScanner) scanner;
            live.stop();
            live.shutdown();
        }
        scanner = null;
    }

    private static void sendProgress(CallbackContext callbackContext, JSONObject event) {
        PluginResult result = new PluginResult(PluginResult.Status.OK, event);
        result.setKeepCallback(true);
        callbackContext.sendPluginResult(result);
    }

    private synchronized OcrEngine getEngine() throws Exception {
        if (engine == null)
            engine = new OcrEngine(cordova.getActivity().getApplicationContext());
        return (OcrEngine) engine;
    }

    @Override
    public void onPause(boolean multitasking) {
        // The camera is released when the app goes to the background; JavaScript restarts it
        cordova.getActivity().runOnUiThread(this::stopPreview);
    }

    @Override
    public void onDestroy() {
        stopPreview();
        if (engine != null)
            ((OcrEngine) engine).close();
        engine = null;
    }
}
