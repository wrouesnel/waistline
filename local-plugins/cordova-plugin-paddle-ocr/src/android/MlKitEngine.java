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
import android.graphics.Point;
import android.os.SystemClock;

import com.google.android.gms.tasks.Tasks;
import com.google.mlkit.common.sdkinternal.MlKitContext;
import com.google.mlkit.vision.common.InputImage;
import com.google.mlkit.vision.text.Text;
import com.google.mlkit.vision.text.TextRecognition;
import com.google.mlkit.vision.text.TextRecognizer;
import com.google.mlkit.vision.text.latin.TextRecognizerOptions;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * Text recognition with Google ML Kit (bundled Latin model, on the device, no Play Services
 * needed). Produces lines in the same form as the PaddleOCR engine.
 *
 * ML Kit's lines can run across a whole table row ("FAT, total  <0.1 g  <0.1%  0.2 g"), so each
 * line is split into pieces wherever the gap between words is wide, as PaddleOCR's boxes are.
 */
class MlKitEngine {

    private static final float SPLIT_GAP = 1.0f; // gap between words, x line height, that splits a line

    private final TextRecognizer recognizer;

    MlKitEngine(Context context) {
        // ML Kit's init provider is removed from the manifest so it only starts when it's chosen
        MlKitContext.initializeIfNeeded(context);
        recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS);
    }

    void close() {
        recognizer.close();
    }

    // Reads all the text in an image (blocking; not on the main thread)
    JSONArray read(Bitmap image) throws Exception {
        Text text = Tasks.await(recognizer.process(InputImage.fromBitmap(image, 0)));
        JSONArray out = new JSONArray();
        for (Text.TextBlock block : text.getTextBlocks()) {
            for (Text.Line line : block.getLines())
                addSegments(line, out);
        }
        return out;
    }

    JSONObject recognizeBitmap(Bitmap image, OcrEngine.Listener listener, JSONObject region) throws Exception {
        long t0 = SystemClock.elapsedRealtime();
        JSONArray all = read(image);
        long t1 = SystemClock.elapsedRealtime();

        JSONArray lines = new JSONArray();
        int skipped = 0;
        for (int i = 0; i < all.length(); i++) {
            JSONObject l = all.getJSONObject(i);
            if (region != null) {
                double fx = l.getDouble("cx") / image.getWidth();
                double fy = l.getDouble("cy") / image.getHeight();
                if (fx < region.optDouble("x0", 0) || fx > region.optDouble("x1", 1) ||
                    fy < region.optDouble("y0", 0) || fy > region.optDouble("y1", 1)) {
                    skipped++;
                    continue;
                }
            }
            lines.put(l);
        }
        if (listener != null) {
            listener.onBoxes(all);
            listener.onLines(lines);
        }

        JSONObject result = new JSONObject();
        result.put("width", image.getWidth());
        result.put("height", image.getHeight());
        result.put("lines", lines);
        result.put("skipped", skipped);
        JSONObject timing = new JSONObject();
        timing.put("detectMs", 0);
        timing.put("recognizeMs", t1 - t0);
        result.put("timing", timing);
        return result;
    }

    private static void addSegments(Text.Line line, JSONArray out) throws Exception {
        Point[] lc = line.getCornerPoints();
        if (lc == null || lc.length < 4)
            return;
        // Direction along the line (top-left to top-right) and its height (top-left to bottom-left)
        double angle = Math.atan2(lc[1].y - lc[0].y, lc[1].x - lc[0].x);
        double ca = Math.cos(angle);
        double sa = Math.sin(angle);
        double height = Math.hypot(lc[3].x - lc[0].x, lc[3].y - lc[0].y);
        if (height < 1)
            return;

        // Each word's extent along the line (u) and across it (v), from its corners
        List<Word> words = new ArrayList<>();
        for (Text.Element e : line.getElements()) {
            Point[] c = e.getCornerPoints();
            if (c == null || c.length < 4)
                continue;
            Word w = new Word();
            w.text = e.getText();
            w.conf = e.getConfidence();
            w.u0 = w.v0 = Double.MAX_VALUE;
            w.u1 = w.v1 = -Double.MAX_VALUE;
            for (Point p : c) {
                double u = p.x * ca + p.y * sa;
                double v = -p.x * sa + p.y * ca;
                w.u0 = Math.min(w.u0, u);
                w.u1 = Math.max(w.u1, u);
                w.v0 = Math.min(w.v0, v);
                w.v1 = Math.max(w.v1, v);
            }
            words.add(w);
        }
        words.sort((a, b) -> Double.compare(a.u0, b.u0));

        // Split at wide gaps
        List<Word> segment = new ArrayList<>();
        for (Word w : words) {
            if (!segment.isEmpty() && w.u0 - segment.get(segment.size() - 1).u1 > SPLIT_GAP * height) {
                out.put(segmentJson(segment, ca, sa));
                segment = new ArrayList<>();
            }
            segment.add(w);
        }
        if (!segment.isEmpty())
            out.put(segmentJson(segment, ca, sa));
    }

    // A word and its extent along the line (u) and across it (v)
    private static class Word {
        String text;
        float conf;
        double u0, u1, v0, v1;
    }

    private static JSONObject segmentJson(List<Word> segment, double ca, double sa) throws Exception {
        StringBuilder text = new StringBuilder();
        double u0 = Double.MAX_VALUE, u1 = -Double.MAX_VALUE, v0 = Double.MAX_VALUE, v1 = -Double.MAX_VALUE;
        double conf = 0;
        for (Word w : segment) {
            if (text.length() > 0)
                text.append(' ');
            text.append(w.text);
            u0 = Math.min(u0, w.u0);
            u1 = Math.max(u1, w.u1);
            v0 = Math.min(v0, w.v0);
            v1 = Math.max(v1, w.v1);
            conf += w.conf;
        }
        double uc = (u0 + u1) / 2;
        double vc = (v0 + v1) / 2;
        JSONObject line = new JSONObject();
        line.put("text", text.toString());
        line.put("conf", Math.round(conf / segment.size() * 1000) / 1000.0);
        line.put("cx", Math.round((uc * ca - vc * sa) * 10) / 10.0);
        line.put("cy", Math.round((uc * sa + vc * ca) * 10) / 10.0);
        line.put("w", Math.round((u1 - u0) * 10) / 10.0);
        line.put("h", Math.round((v1 - v0) * 10) / 10.0);
        line.put("angle", Math.round(Math.atan2(sa, ca) * 10000) / 10000.0);
        return line;
    }
}
