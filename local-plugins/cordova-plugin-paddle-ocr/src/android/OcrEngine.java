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

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Base64;

import androidx.exifinterface.media.ExifInterface;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.FloatBuffer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * PP-OCRv5 mobile text detection + recognition.
 *
 * Detection (DB) gives a text probability map. Connected regions of it become text boxes:
 * regions much taller than a text line are split at the gaps between lines, and each box's
 * orientation comes from the second moments of its pixels. Each box is cropped upright and
 * read by the recognition model with greedy CTC decoding.
 */
class OcrEngine {

    private static final int DET_LIMIT = 960;       // longest side fed to the detector
    private static final float THRESH = 0.3f;       // probability-map binarisation threshold
    private static final float BOX_THRESH = 0.6f;   // minimum mean probability for a box
    private static final float UNCLIP = 1.5f;       // box expansion ratio
    private static final float END_PAD = 0.15f;     // extra length at each end of a line, x its height
    private static final int MIN_SIZE = 3;
    private static final int REC_H = 48;
    private static final int REC_MAX_W = 2400;
    private static final int MAX_SIDE = 4096;       // larger photos are downsampled on load
    private static final int REC_BATCH = 8;         // text lines read per model run
    private static final int REC_WORKERS = 2;       // batches read at the same time
    private static final int CORES = Runtime.getRuntime().availableProcessors();

    private static final float[] DET_MEAN = {0.485f, 0.456f, 0.406f}; // B, G, R
    private static final float[] DET_STD = {0.229f, 0.224f, 0.225f};

    private final Context context;
    // PaddleOCR models, loaded on first use (not at all when ML Kit is used)
    private OrtEnvironment env;
    private OrtSession det;
    private OrtSession rec;
    private String[] chars;
    private MlKitEngine mlkit;
    private final ExecutorService recPool = Executors.newFixedThreadPool(REC_WORKERS);

    static class Box {
        float cx, cy, w, h, angle;
    }

    // Progress while an image is read: the image itself, the text boxes found, then the lines
    // as they are read, in batches
    interface Listener {
        void onImage(JSONObject image) throws Exception;
        void onBoxes(JSONArray boxes) throws Exception;
        void onLines(JSONArray lines) throws Exception;
    }

    OcrEngine(Context context) {
        this.context = context;
    }

    private synchronized void ensurePaddle() throws Exception {
        if (det != null)
            return;
        env = OrtEnvironment.getEnvironment();
        try {
            env.setTelemetry(false);
        } catch (Exception ignored) {
        }
        // Text lines are read two batches at a time with three threads each, which keeps more
        // cores busy than one batch with more threads (on phones these models scale poorly
        // across threads within one run)
        rec = createSession(readAsset("paddleocr/rec.onnx"), Math.max(1, Math.min(3, CORES / REC_WORKERS)));

        // CTC classes: blank, the dictionary, then space
        String[] dict = new String(readAsset("paddleocr/rec_dict.txt"), StandardCharsets.UTF_8).split("\n");
        chars = new String[dict.length + 2];
        chars[0] = "";
        System.arraycopy(dict, 0, chars, 1, dict.length);
        chars[dict.length + 1] = " ";
        det = createSession(readAsset("paddleocr/det.onnx"), Math.max(1, Math.min(4, CORES)));
    }

    synchronized MlKitEngine mlkit() {
        if (mlkit == null)
            mlkit = new MlKitEngine(context);
        return mlkit;
    }

    // Load the chosen engine ahead of use, so the first photo isn't slowed down
    void warmUp(String engine) throws Exception {
        if ("mlkit".equals(engine))
            mlkit();
        else
            ensurePaddle();
    }

    private OrtSession createSession(byte[] model, int threads) throws Exception {
        OrtSession.SessionOptions opts = new OrtSession.SessionOptions();
        opts.setIntraOpNumThreads(threads);
        return env.createSession(model, opts);
    }

    void close() {
        recPool.shutdown();
        try {
            if (det != null)
                det.close();
            if (rec != null)
                rec.close();
        } catch (Exception ignored) {
        }
        if (mlkit != null)
            mlkit.close();
    }

    JSONObject recognize(String uri, JSONObject options) throws Exception {
        return recognize(uri, options, null);
    }

    JSONObject recognize(String uri, JSONObject options, Listener listener) throws Exception {
        Bitmap image = loadBitmap(uri);
        JSONObject crop = options != null ? options.optJSONObject("crop") : null;
        String preview = null;
        int previewMax = options != null ? options.optInt("preview", 0) : 0;
        if (previewMax > 0)
            preview = toDataUrl(image, previewMax);
        if (crop != null) {
            int x0 = clamp((int) Math.floor(crop.getDouble("x0")), 0, image.getWidth() - 1);
            int y0 = clamp((int) Math.floor(crop.getDouble("y0")), 0, image.getHeight() - 1);
            int x1 = clamp((int) Math.ceil(crop.getDouble("x1")), x0 + 1, image.getWidth());
            int y1 = clamp((int) Math.ceil(crop.getDouble("y1")), y0 + 1, image.getHeight());
            image = Bitmap.createBitmap(image, x0, y0, x1 - x0, y1 - y0);
        }
        if (listener != null) {
            JSONObject info = new JSONObject();
            info.put("width", image.getWidth());
            info.put("height", image.getHeight());
            if (preview != null)
                info.put("preview", preview);
            listener.onImage(info);
        }
        JSONObject region = options != null ? options.optJSONObject("region") : null;
        JSONObject result = options != null && "mlkit".equals(options.optString("engine"))
            ? mlkit().recognizeBitmap(image, listener, region)
            : recognizeBitmap(image, options != null ? options.optInt("detLimit", DET_LIMIT) : DET_LIMIT, listener, region);
        if (preview != null)
            result.put("preview", preview);
        return result;
    }

    JSONObject recognizeBitmap(Bitmap image, int detLimit) throws Exception {
        return recognizeBitmap(image, detLimit, null, null);
    }

    // region: {x0, y0, x1, y1} as fractions of the image. Only text whose centre is inside it is
    // read (all text is still found), which saves time when the caller knows where to look.
    JSONObject recognizeBitmap(Bitmap image, int detLimit, Listener listener, JSONObject region) throws Exception {
        long t0 = SystemClock.elapsedRealtime();
        List<Box> boxes = detect(image, detLimit);
        long t1 = SystemClock.elapsedRealtime();
        if (listener != null)
            listener.onBoxes(boxesJson(boxes));

        List<Box> toRead = boxes;
        if (region != null) {
            float x0 = (float) region.optDouble("x0", 0) * image.getWidth();
            float y0 = (float) region.optDouble("y0", 0) * image.getHeight();
            float x1 = (float) region.optDouble("x1", 1) * image.getWidth();
            float y1 = (float) region.optDouble("y1", 1) * image.getHeight();
            toRead = new ArrayList<>();
            for (Box b : boxes) {
                if (b.cx >= x0 && b.cx <= x1 && b.cy >= y0 && b.cy <= y1)
                    toRead.add(b);
            }
        }

        JSONArray lines = new JSONArray();
        readBoxes(image, toRead, (batch) -> {
            for (int i = 0; i < batch.length(); i++)
                lines.put(batch.get(i));
            if (listener != null)
                listener.onLines(batch);
        });
        long t2 = SystemClock.elapsedRealtime();

        JSONObject result = new JSONObject();
        result.put("width", image.getWidth());
        result.put("height", image.getHeight());
        result.put("lines", lines);
        result.put("skipped", boxes.size() - toRead.size());
        JSONObject timing = new JSONObject();
        timing.put("detectMs", t1 - t0);
        timing.put("recognizeMs", t2 - t1);
        result.put("timing", timing);
        return result;
    }

    List<Box> detectBoxes(Bitmap image, int detLimit) throws Exception {
        return detect(image, detLimit);
    }

    static JSONArray boxesJson(List<Box> boxes) throws JSONException {
        JSONArray out = new JSONArray();
        for (Box b : boxes)
            out.put(boxJson(b, new JSONObject()));
        return out;
    }

    private static JSONObject boxJson(Box b, JSONObject out) throws JSONException {
        out.put("cx", round(b.cx, 1));
        out.put("cy", round(b.cy, 1));
        out.put("w", round(b.w, 1));
        out.put("h", round(b.h, 1));
        out.put("angle", round(b.angle, 4));
        return out;
    }

    // ---- Detection ----

    private List<Box> detect(Bitmap image, int detLimit) throws Exception {
        ensurePaddle();
        int w = image.getWidth();
        int h = image.getHeight();
        float scale = (float) detLimit / Math.max(w, h);
        int nh = Math.max(32, Math.round(h * scale / 32f) * 32);
        int nw = Math.max(32, Math.round(w * scale / 32f) * 32);
        Bitmap scaled = Bitmap.createScaledBitmap(image, nw, nh, true);
        int[] px = new int[nw * nh];
        scaled.getPixels(px, 0, nw, 0, 0, nw, nh);

        int plane = nw * nh;
        FloatBuffer input = FloatBuffer.allocate(3 * plane);
        float[] data = input.array();
        for (int i = 0; i < plane; i++) {
            int p = px[i];
            data[i] = ((p & 0xff) / 255f - DET_MEAN[0]) / DET_STD[0];                     // B
            data[plane + i] = (((p >> 8) & 0xff) / 255f - DET_MEAN[1]) / DET_STD[1];      // G
            data[2 * plane + i] = (((p >> 16) & 0xff) / 255f - DET_MEAN[2]) / DET_STD[2]; // R
        }

        float[] prob = new float[plane];
        try (OnnxTensor tensor = OnnxTensor.createTensor(env, input, new long[]{1, 3, nh, nw});
             OrtSession.Result out = det.run(Collections.singletonMap("x", tensor))) {
            ((OnnxTensor) out.get(0)).getFloatBuffer().get(prob);
        }

        // Connected components (4-connected) of the thresholded map
        int[] labels = new int[plane];
        List<int[]> stats = new ArrayList<>(); // {x0, y0, x1, y1} inclusive, index = label - 1
        int[] queue = new int[plane];
        for (int start = 0; start < plane; start++) {
            if (prob[start] <= THRESH || labels[start] != 0)
                continue;
            int id = stats.size() + 1;
            int[] s = {start % nw, start / nw, start % nw, start / nw};
            int head = 0;
            int tail = 0;
            queue[tail++] = start;
            labels[start] = id;
            while (head < tail) {
                int i = queue[head++];
                int x = i % nw;
                int y = i / nw;
                if (x < s[0]) s[0] = x;
                if (x > s[2]) s[2] = x;
                if (y < s[1]) s[1] = y;
                if (y > s[3]) s[3] = y;
                if (x > 0 && labels[i - 1] == 0 && prob[i - 1] > THRESH) { labels[i - 1] = id; queue[tail++] = i - 1; }
                if (x < nw - 1 && labels[i + 1] == 0 && prob[i + 1] > THRESH) { labels[i + 1] = id; queue[tail++] = i + 1; }
                if (y > 0 && labels[i - nw] == 0 && prob[i - nw] > THRESH) { labels[i - nw] = id; queue[tail++] = i - nw; }
                if (y < nh - 1 && labels[i + nw] == 0 && prob[i + nw] > THRESH) { labels[i + nw] = id; queue[tail++] = i + nw; }
            }
            stats.add(s);
        }

        // Components much taller than a text line are usually several stacked lines that
        // touched; split them at the rows where the probability drops
        int[] heights = new int[stats.size()];
        for (int k = 0; k < stats.size(); k++)
            heights[k] = stats.get(k)[3] - stats.get(k)[1] + 1;
        Arrays.sort(heights);
        int lineH = heights.length > 0 ? heights[heights.length / 2] : 0;

        List<int[]> comps = new ArrayList<>(); // {label, x0, y0, bw, bh}
        for (int k = 0; k < stats.size(); k++) {
            int[] s = stats.get(k);
            int id = k + 1;
            int bw = s[2] - s[0] + 1;
            int bh = s[3] - s[1] + 1;
            if (lineH > 0 && bh > 1.8f * lineH && bw < 6 * bh) {
                int segStart = -1;
                for (int r = 0; r <= bh; r++) {
                    boolean on = false;
                    if (r < bh) {
                        float sum = 0;
                        int count = 0;
                        int row = (s[1] + r) * nw;
                        for (int x = s[0]; x <= s[2]; x++) {
                            if (labels[row + x] == id) {
                                sum += prob[row + x];
                                count++;
                            }
                        }
                        on = sum / Math.max(1, count) > 0.5f;
                    }
                    if (on && segStart < 0) {
                        segStart = r;
                    } else if (!on && segStart >= 0) {
                        if (r - segStart >= MIN_SIZE)
                            comps.add(new int[]{id, s[0], s[1] + segStart, bw, r - segStart});
                        segStart = -1;
                    }
                }
            } else {
                comps.add(new int[]{id, s[0], s[1], bw, bh});
            }
        }

        float sx = (float) w / nw;
        float sy = (float) h / nh;
        List<Box> boxes = new ArrayList<>();
        for (int[] c : comps) {
            int id = c[0], x0 = c[1], y0 = c[2], bw = c[3], bh = c[4];
            if (Math.min(bw, bh) < MIN_SIZE)
                continue;

            // Score and first/second moments of the component's pixels, in image coordinates
            int area = 0;
            double score = 0, mx = 0, my = 0;
            for (int y = y0; y < y0 + bh; y++) {
                for (int x = x0; x < x0 + bw; x++) {
                    int i = y * nw + x;
                    if (labels[i] != id)
                        continue;
                    area++;
                    score += prob[i];
                    mx += x * sx;
                    my += y * sy;
                }
            }
            if (area == 0 || score / area < BOX_THRESH)
                continue;
            mx /= area;
            my /= area;
            double cxx = 0, cyy = 0, cxy = 0;
            for (int y = y0; y < y0 + bh; y++) {
                for (int x = x0; x < x0 + bw; x++) {
                    if (labels[y * nw + x] != id)
                        continue;
                    double dx = x * sx - mx;
                    double dy = y * sy - my;
                    cxx += dx * dx;
                    cyy += dy * dy;
                    cxy += dx * dy;
                }
            }
            double ang = 0.5 * Math.atan2(2 * cxy / area, cxx / area - cyy / area);
            if (Math.abs(ang) > Math.PI / 4) // long axis vertical: treat as upright text
                ang = 0;
            double ca = Math.cos(ang);
            double sa = Math.sin(ang);

            // Extent along (u) and across (v) the text direction
            double umin = Double.MAX_VALUE, umax = -Double.MAX_VALUE, vmin = Double.MAX_VALUE, vmax = -Double.MAX_VALUE;
            for (int y = y0; y < y0 + bh; y++) {
                for (int x = x0; x < x0 + bw; x++) {
                    if (labels[y * nw + x] != id)
                        continue;
                    double dx = x * sx - mx;
                    double dy = y * sy - my;
                    double u = dx * ca + dy * sa;
                    double v = -dx * sa + dy * ca;
                    umin = Math.min(umin, u);
                    umax = Math.max(umax, u);
                    vmin = Math.min(vmin, v);
                    vmax = Math.max(vmax, v);
                }
            }
            double bl = umax - umin + sx;
            double bt = vmax - vmin + sy;
            double uc = (umax + umin) / 2;
            double vc = (vmax + vmin) / 2;

            // DB "unclip": grow the box by area * ratio / perimeter, using the region's real area
            double d = (area * sx * sy) * UNCLIP / (2 * (bl + bt));
            Box b = new Box();
            b.h = (float) (bt + 2 * d);
            // A little more room at the ends: the probability map often stops short of the
            // last letters ("FAT, total" read without "total" reads as nothing)
            b.w = (float) (bl + 2 * d) + 2 * END_PAD * b.h;
            b.cx = (float) (mx + uc * ca - vc * sa);
            b.cy = (float) (my + uc * sa + vc * ca);
            b.angle = (float) ang;
            boxes.add(b);
        }
        return boxes;
    }

    // ---- Recognition ----

    interface BatchSink {
        void accept(JSONArray lines) throws Exception;
    }

    // Reads the text in each box. Crops of similar width are read together in batches, padded
    // on the right to the widest crop in the batch (as PaddleOCR does), which is much faster
    // than reading them one at a time.
    void readBoxes(Bitmap image, List<Box> boxes, BatchSink sink) throws Exception {
        ensurePaddle();
        List<Box> empty = Collections.synchronizedList(new ArrayList<>());
        readBoxes(image, boxes, sink, empty);

        // Text clipped at the ends can read as nothing: try those again with more room
        if (!empty.isEmpty()) {
            List<Box> wider = new ArrayList<>();
            for (Box b : empty) {
                Box w = new Box();
                w.cx = b.cx;
                w.cy = b.cy;
                w.w = b.w + 1.2f * b.h;
                w.h = b.h;
                w.angle = b.angle;
                wider.add(w);
            }
            readBoxes(image, wider, sink, null);
        }
    }

    private void readBoxes(Bitmap image, List<Box> boxes, BatchSink sink, List<Box> empty) throws Exception {
        int n = boxes.size();
        Bitmap[] crops = new Bitmap[n];
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            Box b = boxes.get(i);
            int cw = Math.round(b.w);
            int ch = Math.round(b.h);
            if (cw < 2 || ch < 2)
                continue;
            // Rotate the image about the box centre so the text is horizontal, then crop it
            int rw = Math.min(REC_MAX_W, Math.max(8, (int) Math.ceil((double) REC_H * cw / ch)));
            crops[i] = Bitmap.createScaledBitmap(uprightCrop(image, b), rw, REC_H, true);
            order.add(i);
        }
        order.sort((a, b) -> Integer.compare(crops[a].getWidth(), crops[b].getWidth()));

        List<Future<JSONArray>> results = new ArrayList<>();
        for (int start = 0; start < order.size(); start += REC_BATCH) {
            final List<Integer> batch = order.subList(start, Math.min(order.size(), start + REC_BATCH));
            results.add(recPool.submit(() -> readBatch(boxes, crops, batch, empty)));
        }
        for (Future<JSONArray> f : results)
            sink.accept(f.get());
    }

    private JSONArray readBatch(List<Box> boxes, Bitmap[] crops, List<Integer> batch, List<Box> empty) throws Exception {
        {
            int width = crops[batch.get(batch.size() - 1)].getWidth();
            int plane = REC_H * width;
            FloatBuffer input = FloatBuffer.allocate(batch.size() * 3 * plane); // zero = mid grey
            float[] data = input.array();
            for (int k = 0; k < batch.size(); k++) {
                Bitmap crop = crops[batch.get(k)];
                int cw = crop.getWidth();
                int[] px = new int[cw * REC_H];
                crop.getPixels(px, 0, cw, 0, 0, cw, REC_H);
                int base = k * 3 * plane;
                for (int y = 0; y < REC_H; y++) {
                    for (int x = 0; x < cw; x++) {
                        int p = px[y * cw + x];
                        int i = base + y * width + x;
                        data[i] = (p & 0xff) / 127.5f - 1f;                     // B
                        data[i + plane] = ((p >> 8) & 0xff) / 127.5f - 1f;      // G
                        data[i + 2 * plane] = ((p >> 16) & 0xff) / 127.5f - 1f; // R
                    }
                }
            }

            JSONArray lines = new JSONArray();
            try (OnnxTensor tensor = OnnxTensor.createTensor(env, input, new long[]{batch.size(), 3, REC_H, width});
                 OrtSession.Result out = rec.run(Collections.singletonMap("x", tensor))) {
                OnnxTensor result = (OnnxTensor) out.get(0);
                long[] shape = result.getInfo().getShape(); // [batch, T, classes]
                int steps = (int) shape[1];
                int classes = (int) shape[2];
                float[] probs = new float[batch.size() * steps * classes];
                result.getFloatBuffer().get(probs);

                for (int k = 0; k < batch.size(); k++) {
                    // Greedy CTC decoding: best class per step, collapse repeats, drop blanks
                    StringBuilder text = new StringBuilder();
                    float confSum = 0;
                    int confCount = 0;
                    int prev = 0;
                    for (int t = 0; t < steps; t++) {
                        int row = (k * steps + t) * classes;
                        int best = 0;
                        float bestP = probs[row];
                        for (int c = 1; c < classes; c++) {
                            if (probs[row + c] > bestP) {
                                bestP = probs[row + c];
                                best = c;
                            }
                        }
                        if (best != 0 && best != prev && best < chars.length) {
                            text.append(chars[best]);
                            confSum += bestP;
                            confCount++;
                        }
                        prev = best;
                    }
                    if (text.toString().trim().isEmpty()) {
                        if (empty != null)
                            empty.add(boxes.get(batch.get(k)));
                        continue;
                    }
                    JSONObject line = new JSONObject();
                    line.put("text", text.toString());
                    line.put("conf", round(confCount > 0 ? confSum / confCount : 0, 3));
                    boxJson(boxes.get(batch.get(k)), line);
                    lines.put(line);
                }
            }
            return lines;
        }
    }

    // Straightened crop of a rotated box ({cx, cy, w, h, angle} in image pixels), as a JPEG data URL
    String cropImage(String uri, JSONObject box, int maxSide) throws Exception {
        Bitmap image = loadBitmap(uri);
        Box b = new Box();
        b.cx = (float) box.getDouble("cx");
        b.cy = (float) box.getDouble("cy");
        b.w = (float) box.getDouble("w");
        b.h = (float) box.getDouble("h");
        b.angle = (float) box.optDouble("angle", 0);
        return toDataUrl(uprightCrop(image, b), maxSide);
    }

    private Bitmap uprightCrop(Bitmap image, Box b) {
        int cw = Math.max(1, Math.round(b.w));
        int ch = Math.max(1, Math.round(b.h));
        Bitmap crop = Bitmap.createBitmap(cw, ch, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(crop);
        canvas.drawColor(edgeColour(image, b));
        Matrix m = new Matrix();
        m.postTranslate(-b.cx, -b.cy);
        m.postRotate((float) -Math.toDegrees(b.angle));
        m.postTranslate(cw / 2f, ch / 2f);
        canvas.drawBitmap(image, m, new Paint(Paint.FILTER_BITMAP_FLAG));
        return crop;
    }

    private static String toDataUrl(Bitmap image, int maxSide) {
        float scale = Math.min(1f, (float) maxSide / Math.max(image.getWidth(), image.getHeight()));
        Bitmap scaled = scale < 1f
            ? Bitmap.createScaledBitmap(image, Math.round(image.getWidth() * scale), Math.round(image.getHeight() * scale), true)
            : image;
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        scaled.compress(Bitmap.CompressFormat.JPEG, 85, out);
        return "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
    }

    // Average colour at the box's corners, to fill any part of the crop outside the image
    private int edgeColour(Bitmap image, Box b) {
        int r = 0, g = 0, bl = 0;
        float ca = (float) Math.cos(b.angle);
        float sa = (float) Math.sin(b.angle);
        int[][] corners = {{-1, -1}, {1, -1}, {1, 1}, {-1, 1}};
        for (int[] c : corners) {
            float u = c[0] * b.w / 2;
            float v = c[1] * b.h / 2;
            int x = clamp(Math.round(b.cx + u * ca - v * sa), 0, image.getWidth() - 1);
            int y = clamp(Math.round(b.cy + u * sa + v * ca), 0, image.getHeight() - 1);
            int p = image.getPixel(x, y);
            r += (p >> 16) & 0xff;
            g += (p >> 8) & 0xff;
            bl += p & 0xff;
        }
        return 0xff000000 | ((r / 4) << 16) | ((g / 4) << 8) | (bl / 4);
    }

    // ---- Image loading ----

    private Bitmap loadBitmap(String uri) throws IOException {
        byte[] bytes = readUri(uri);

        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(bytes, 0, bytes.length, bounds);
        BitmapFactory.Options opts = new BitmapFactory.Options();
        opts.inSampleSize = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / opts.inSampleSize > MAX_SIDE)
            opts.inSampleSize *= 2;
        opts.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.length, opts);
        if (bitmap == null)
            throw new IOException("Could not decode image");

        // Apply the EXIF orientation so text is the right way up
        int orientation = new ExifInterface(new ByteArrayInputStream(bytes))
            .getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
        int degrees = 0;
        if (orientation == ExifInterface.ORIENTATION_ROTATE_90)
            degrees = 90;
        else if (orientation == ExifInterface.ORIENTATION_ROTATE_180)
            degrees = 180;
        else if (orientation == ExifInterface.ORIENTATION_ROTATE_270)
            degrees = 270;
        if (degrees != 0) {
            Matrix m = new Matrix();
            m.postRotate(degrees);
            bitmap = Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), m, true);
        }
        return bitmap;
    }

    private byte[] readUri(String uri) throws IOException {
        if (uri.startsWith("data:")) {
            return Base64.decode(uri.substring(uri.indexOf(',') + 1), Base64.DEFAULT);
        }
        InputStream in;
        if (uri.startsWith("content:")) {
            in = context.getContentResolver().openInputStream(Uri.parse(uri));
        } else {
            String path = uri.startsWith("file:") ? Uri.parse(uri).getPath() : uri;
            in = new FileInputStream(path);
        }
        if (in == null)
            throw new IOException("Could not open " + uri);
        try {
            return readAll(in);
        } finally {
            in.close();
        }
    }

    private byte[] readAsset(String name) throws IOException {
        try (InputStream in = context.getAssets().open(name)) {
            return readAll(in);
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0)
            out.write(buf, 0, n);
        return out.toByteArray();
    }

    private static int clamp(int v, int lo, int hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private static double round(double v, int places) {
        double f = Math.pow(10, places);
        return Math.round(v * f) / f;
    }
}
