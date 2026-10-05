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

var exec = require("cordova/exec");

module.exports = {
  // Resolves to true when on-device OCR can run (Android 7.0+)
  isAvailable: function() {
    return new Promise(function(resolve) {
      exec(resolve, function() { resolve(false); }, "PaddleOcr", "isAvailable", []);
    });
  },

  // Recognises text in an image (file://, content:// or data: URI).
  // options.crop: {x0, y0, x1, y1} in the image's pixel coordinates, to read only part of it.
  // Resolves to {width, height, lines: [{text, conf, cx, cy, w, h, angle}]}, with coordinates
  // relative to the (cropped) image and angle in radians.
  // options.preview: also return a JPEG data URL of the whole image, at most this many pixels
  // on its longest side.
  recognize: function(imageUri, options) {
    return new Promise(function(resolve, reject) {
      exec(resolve, reject, "PaddleOcr", "recognize", [imageUri, options || {}]);
    });
  },

  // Like recognize(), but reports progress as it goes: onEvent({event: "image", width, height,
  // preview}) once the image is loaded, {event: "boxes", boxes} once text is found, and
  // {event: "lines", lines} for each batch of lines read. Resolves to the full result.
  recognizeStream: function(imageUri, options, onEvent) {
    return new Promise(function(resolve, reject) {
      exec(function(event) {
        if (event.event == "done")
          resolve(event);
        else
          onEvent(event);
      }, reject, "PaddleOcr", "recognize", [imageUri, Object.assign({}, options, { stream: true })]);
    });
  },

  // Straightened crop of a rotated box {cx, cy, w, h, angle} as a JPEG data URL
  cropImage: function(imageUri, box, maxSide) {
    return new Promise(function(resolve, reject) {
      exec(resolve, reject, "PaddleOcr", "cropImage", [imageUri, box, maxSide || 2000]);
    });
  },

  // Shows the camera preview behind the WebView (which must be transparent where it should
  // show) and calls onEvent with {event: "started" | "boxes" | "frame" | "error" | "stopped", ...}.
  // "boxes" ({width, height, boxes}) comes for every frame analysed; "frame" ({width, height,
  // lines}, like recognize()) whenever the text of a frame has been read, which is slower.
  // Coordinates are for the visible preview area.
  startPreview: function(onEvent, onError) {
    exec(onEvent, onError, "PaddleOcr", "startPreview", []);
  },

  // Takes a full resolution photo of the preview area. Resolves to its file:// URI.
  capture: function() {
    return new Promise(function(resolve, reject) {
      exec(resolve, reject, "PaddleOcr", "capture", []);
    });
  },

  stopPreview: function() {
    return new Promise(function(resolve, reject) {
      exec(resolve, reject, "PaddleOcr", "stopPreview", []);
    });
  }
};
