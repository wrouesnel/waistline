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

/*
  Reads nutrition values from a photo of a nutrition table, on the device, and fills them into
  the food editor after the user has reviewed them.

  The camera opens a live preview that outlines the text and the nutrition table it has found.
  The review screen shows the photo above the values; tapping a nutrient highlights where its
  label and value were read from.
*/

app.NutritionScanner = {

  live: undefined,      // live preview state while it is open
  review: undefined,    // review popup while it is open

  strings: function() {
    return app.strings["food-editor"] || {};
  },

  // Shows the scan button when on-device text recognition is available (Android 7.0+)
  init: async function(button) {
    button.style.display = "none";
    if (typeof PaddleOcr === "undefined" || typeof Camera === "undefined")
      return;
    try {
      if (await PaddleOcr.isAvailable())
        button.style.display = "";
    } catch (e) {
      console.error(e);
    }
  },

  start: function() {
    const strings = this.strings();
    app.f7.actions.create({
      buttons: [
        [{
            text: strings["scan-label"] || "Scan Nutrition Label",
            label: true
          },
          {
            text: strings["take-photo"] || "Take Photo",
            onClick: () => this.openLive()
          },
          {
            text: strings["choose-photo"] || "Choose Photo",
            onClick: () => this.choosePhoto()
          }
        ],
        [{
          text: app.strings.dialogs.cancel || "Cancel",
          color: "red"
        }]
      ]
    }).open();
  },

  choosePhoto: function() {
    let options = {
      quality: 90,
      sourceType: Camera.PictureSourceType.PHOTOLIBRARY,
      destinationType: Camera.DestinationType.FILE_URI,
      encodingType: Camera.EncodingType.JPEG,
      mediaType: Camera.MediaType.PICTURE,
      correctOrientation: true
    };
    navigator.camera.getPicture((uri) => this.scan(uri), (message) => {
      if (message && !/cancel|no image selected/i.test(message))
        console.error("Nutrition scanner: " + message);
    }, options);
  },

  // Called by the app's back button handler. Returns true if the scanner handled it.
  handleBackButton: function() {
    if (this.live !== undefined) {
      this.closeLive();
      return true;
    }
    if (this.review !== undefined) {
      this.review.close();
      return true;
    }
    return false;
  },

  // ---- Live preview ----

  openLive: function() {
    const strings = this.strings();
    let el = document.createElement("div");
    el.className = "nutrition-live";
    el.innerHTML = `
      <canvas></canvas>
      <div class="live-top">
        <a href="#" class="link icon-only live-close"><i class="icon material-icons">close</i></a>
        <div class="live-status"></div>
      </div>
      <div class="live-bottom"><a href="#" class="live-shutter"></a></div>`;
    document.querySelector("#app").appendChild(el);
    document.documentElement.classList.add("nutrition-live-active");

    this.live = {
      el: el,
      canvas: el.querySelector("canvas"),
      status: el.querySelector(".live-status"),
      colour: getComputedStyle(document.querySelector("#app")).getPropertyValue("--f7-theme-color").trim() || "#f44336",
      synonyms: this.localSynonyms(),
      capturing: false
    };
    this.live.status.innerText = strings["point-at-label"] || "Point the camera at the nutrition table";

    el.querySelector(".live-close").addEventListener("click", (e) => {
      e.preventDefault();
      this.closeLive();
    });
    el.querySelector(".live-shutter").addEventListener("click", (e) => {
      e.preventDefault();
      this.captureLive();
    });

    // The camera is released when the app is paused; start it again on return
    this.live.onResume = () => {
      if (this.live !== undefined && !this.live.capturing)
        this.startPreview();
    };
    document.addEventListener("resume", this.live.onResume);

    this.startPreview();
  },

  startPreview: function() {
    PaddleOcr.startPreview((event) => {
      if (this.live === undefined)
        return;
      if (event.event == "boxes") {
        this.live.frame = event;
        this.drawLive();
      } else if (event.event == "frame") {
        this.readLive(event);
        this.drawLive();
      } else if (event.event == "error") {
        console.error("Nutrition scanner: " + event.message);
      }
    }, (message) => {
      console.error("Nutrition scanner: " + message);
      app.Utils.toast(app.strings.dialogs["camera-problem"] || "There was a problem accessing your camera.");
      this.closeLive();
    });
  },

  // The text of a recent frame has been read: note which lines are nutrient labels and values
  readLive: function(frame) {
    let live = this.live;
    let result = app.NutritionLabelParser.parse(frame.lines, live.synonyms);
    let column = this.bestColumn(result);
    live.roles = [];
    live.count = column ? Object.keys(column.values).length : 0;
    if (column === undefined)
      return;
    let lineOf = (box) => frame.lines.find((l) => this.contains(l, box.cx, box.cy));
    for (let key in column.values) {
      let source = column.values[key].source || {};
      if (source.label)
        live.roles.push({ box: source.label, role: "label" });
      let valueLine = source.value ? lineOf(source.value) : undefined;
      if (valueLine)
        live.roles.push({ box: valueLine, role: "value" });
    }
  },

  // Whether a point is inside a (rotated) box
  contains: function(box, x, y) {
    let c = Math.cos(box.angle || 0);
    let s = Math.sin(box.angle || 0);
    let u = (x - box.cx) * c + (y - box.cy) * s;
    let v = -(x - box.cx) * s + (y - box.cy) * c;
    return Math.abs(u) <= box.w / 2 && Math.abs(v) <= box.h / 2;
  },

  // Outlines the text boxes of the latest frame. Boxes that were read as nutrient labels or
  // values in a recent frame are coloured, and the table around them is outlined.
  drawLive: function() {
    const strings = this.strings();
    let live = this.live;
    let frame = live.frame;
    let canvas = live.canvas;
    let dpr = window.devicePixelRatio || 1;
    let cw = canvas.clientWidth;
    let ch = canvas.clientHeight;
    if (canvas.width != Math.round(cw * dpr) || canvas.height != Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
    }
    let ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (frame === undefined)
      return;

    // The frame covers the preview, which fills the screen
    let s = Math.max(cw / frame.width, ch / frame.height);
    let ox = (cw - frame.width * s) / 2;
    let oy = (ch - frame.height * s) / 2;
    let draw = (box, stroke, fill, width) => {
      ctx.save();
      ctx.translate(ox + box.cx * s, oy + box.cy * s);
      ctx.rotate(box.angle || 0);
      ctx.beginPath();
      ctx.rect(-box.w * s / 2, -box.h * s / 2, box.w * s, box.h * s);
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      ctx.lineWidth = width;
      ctx.strokeStyle = stroke;
      ctx.stroke();
      ctx.restore();
    };

    let table = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let found = 0;
    frame.boxes.forEach((box) => {
      let match = (live.roles || []).find((r) => this.contains(r.box, box.cx, box.cy));
      if (match === undefined) {
        draw(box, "rgba(255, 255, 255, 0.5)", null, 1);
        return;
      }
      found++;
      if (match.role == "label")
        draw(box, "#ffd600", "rgba(255, 214, 0, 0.2)", 1.5);
      else
        draw(box, "#4caf50", "rgba(76, 175, 80, 0.3)", 1.5);
      table.x0 = Math.min(table.x0, box.cx - box.w / 2);
      table.x1 = Math.max(table.x1, box.cx + box.w / 2);
      table.y0 = Math.min(table.y0, box.cy - box.h / 2);
      table.y1 = Math.max(table.y1, box.cy + box.h / 2);
    });

    if (found >= 2) {
      // Remember where the table is, so the photo only needs that part read
      live.table = {
        x0: table.x0 / frame.width, y0: table.y0 / frame.height,
        x1: table.x1 / frame.width, y1: table.y1 / frame.height, time: Date.now()
      };
      let m = 8 / s;
      draw({ cx: (table.x0 + table.x1) / 2, cy: (table.y0 + table.y1) / 2,
        w: table.x1 - table.x0 + 2 * m, h: table.y1 - table.y0 + 2 * m, angle: 0 }, live.colour, null, 2);
      live.status.innerText = (strings["table-found"] || "Nutrition table found") + ": " + live.count;
    } else {
      live.status.innerText = strings["point-at-label"] || "Point the camera at the nutrition table";
    }
  },

  captureLive: async function() {
    let live = this.live;
    if (live === undefined || live.capturing)
      return;
    live.capturing = true;
    live.el.querySelector(".live-shutter").style.opacity = "0.4";
    try {
      // The shutter works straight away: if the camera is still starting, wait for it
      let uri;
      for (let attempt = 0; uri === undefined; attempt++) {
        try {
          uri = await PaddleOcr.capture();
        } catch (e) {
          if (attempt >= 15 || !/not ready|not running/i.test(String(e)) || this.live !== live)
            throw e;
          await new Promise((resolve) => setTimeout(resolve, 200));
        }
      }
      // The photo shows what the preview showed, so the table found live is in the same place
      let region;
      let t = live.table;
      if (t !== undefined && Date.now() - t.time < 3000) {
        let mx = (t.x1 - t.x0) * 0.15 + 0.03;
        let my = (t.y1 - t.y0) * 0.15 + 0.03;
        region = { x0: Math.max(0, t.x0 - mx), y0: Math.max(0, t.y0 - my), x1: Math.min(1, t.x1 + mx), y1: Math.min(1, t.y1 + my) };
      }
      this.closeLive();
      this.scan(uri, region);
    } catch (e) {
      console.error(e);
      live.capturing = false;
      live.el.querySelector(".live-shutter").style.opacity = "";
      app.Utils.toast(app.strings.dialogs["camera-problem"] || "There was a problem accessing your camera.");
    }
  },

  closeLive: function() {
    let live = this.live;
    if (live === undefined)
      return;
    this.live = undefined;
    document.removeEventListener("resume", live.onResume);
    PaddleOcr.stopPreview().catch((e) => console.error(e));
    live.el.remove();
    document.documentElement.classList.remove("nutrition-live-active");
  },

  // ---- Reading a photo ----

  // Opens the review straight away and fills it in as the photo is read. region: where the
  // table is (fractions of the photo), if known, so only that part needs reading.
  scan: async function(uri, region) {
    const strings = this.strings();
    let review = this.openReview(uri);

    try {
      let synonyms = this.localSynonyms();

      // Show values as soon as their rows have been read
      let read = (options, dx, dy) => {
        let lines = [];
        return PaddleOcr.recognizeStream(uri, options, (event) => {
          if (event.event == "image") {
            // Later reads (of a crop, or the whole photo again) report their own size and no
            // preview: the photo shown stays the first one
            if (event.preview !== undefined)
              review.setImage(event);
          } else if (event.event == "boxes") {
            review.addBoxes(event.boxes, dx, dy);
          } else if (event.event == "lines") {
            review.addLines(event.lines, dx, dy);
            lines = lines.concat(event.lines.map((l) => Object.assign({}, l, { cx: l.cx + dx, cy: l.cy + dy })));
            let partial = app.NutritionLabelParser.parse(lines, synonyms);
            if (partial.columns.length > 0)
              review.setResult(partial, undefined, true);
          }
        });
      };

      let first = await read({ preview: 1600, region: region }, 0, 0);
      if (!review.isOpen())
        return;
      // Nothing useful where the live view saw the table: read the whole photo
      if (region !== undefined && first.skipped > 0 &&
          this.countValues(app.NutritionLabelParser.parse(first.lines, synonyms)) < 4) {
        review.clearBoxes();
        first = Object.assign(await read({}, 0, 0), { preview: first.preview });
        if (!review.isOpen())
          return;
      }
      let image = { uri: uri, width: first.width, height: first.height, preview: first.preview };
      let result = app.NutritionLabelParser.parse(first.lines, synonyms);
      review.showTable(result);

      // A small table in a large photo that didn't read well: read the table's region again, at a
      // higher resolution
      let b = result.bounds;
      if (b !== undefined && this.countValues(result) < 8 &&
          (b.x1 - b.x0) * (b.y1 - b.y0) < 0.4 * first.width * first.height) {
        let mx = 0.15 * (b.x1 - b.x0) + 20;
        let my = 0.15 * (b.y1 - b.y0) + 20;
        let crop = {
          x0: Math.max(0, Math.floor(b.x0 - mx)),
          y0: Math.max(0, Math.floor(b.y0 - my)),
          x1: Math.min(first.width, b.x1 + mx),
          y1: Math.min(first.height, b.y1 + my)
        };
        review.clearBoxes();
        let second = await read({ crop: crop }, crop.x0, crop.y0);
        if (!review.isOpen())
          return;
        // Back into the coordinates of the whole photo
        let lines = second.lines.map((l) => Object.assign({}, l, { cx: l.cx + crop.x0, cy: l.cy + crop.y0 }));
        let zoomed = app.NutritionLabelParser.parse(lines, synonyms);
        if (this.countValues(zoomed) >= this.countValues(result))
          result = zoomed;
      }

      if (result.columns.length == 0)
        review.showMessage(strings["no-table-found"] || "Couldn't find a nutrition table. Try a closer, straighter photo.");
      else
        review.setResult(result, image);
    } catch (e) {
      console.error(e);
      review.showMessage(strings["scan-failed"] || "Couldn't read the photo.");
    }
  },

  countValues: function(result) {
    return Math.max.apply(null, result.columns.map((c) => Object.keys(c.values).length).concat([0]));
  },

  // Per 100 g/ml if the label has it, otherwise the column with the most values
  bestColumn: function(result) {
    let best;
    result.columns.forEach((c) => {
      if (best === undefined || (c.basis == "100" && best.basis != "100") ||
          (c.basis == best.basis && Object.keys(c.values).length > Object.keys(best.values).length))
        best = c;
    });
    return best;
  },

  // Nutrient names in the app's language, so labels in that language match too
  localSynonyms: function() {
    let synonyms = {};
    let names = app.strings.nutriments || {};
    for (let key in names) {
      let target = (key == "calories" || key == "kilojoules") ? "energy" : key;
      let name = app.NutritionLabelParser.normalise(String(names[key]));
      if (name.length > 1)
        (synonyms[target] = synonyms[target] || []).push(name);
    }
    return synonyms;
  },

  columnTitle: function(column, index) {
    const strings = this.strings();
    if (column.basis == "100")
      return column.unit == "ml" ? (strings["per-100ml"] || "Per 100ml") : (strings["per-100g"] || "Per 100g");
    if (column.basis == "serving") {
      let title = strings["per-serving"] || "Per Serving";
      if (column.amount !== undefined)
        title += " (" + column.amount + (column.unit || "") + ")";
      return title;
    }
    return (strings["column"] || "Column") + " " + (index + 1);
  },

  // Column values in the app's units, filling in kcal/kJ and salt/sodium from each other
  columnValues: function(column) {
    const units = app.Nutriments.getNutrimentUnits();
    const parser = app.NutritionLabelParser;
    let values = {};
    for (let key in column.values) {
      let v = parser.toAppUnit(key, column.values[key], units[key]);
      if (v !== undefined && !isNaN(v))
        values[key] = v;
    }

    if (values.kilojoules === undefined && values.calories !== undefined)
      values.kilojoules = app.Utils.convertUnit(values.calories, units.calories, units.kilojoules, 1);
    if (values.calories === undefined && values.kilojoules !== undefined)
      values.calories = app.Utils.convertUnit(values.kilojoules, units.kilojoules, units.calories, 1);

    // Salt = sodium x 2.5, worked out in grams
    let saltFactor = parser.unitFactors[units.salt];
    let sodiumFactor = parser.unitFactors[units.sodium];
    if (saltFactor !== undefined && sodiumFactor !== undefined) {
      if (values.salt === undefined && values.sodium !== undefined)
        values.salt = values.sodium * sodiumFactor * 2.5 / saltFactor;
      if (values.sodium === undefined && values.salt !== undefined)
        values.sodium = values.salt * saltFactor / 2.5 / sodiumFactor;
    }

    for (let key in values)
      values[key] = Math.round(values[key] * 1000) / 1000;
    return values;
  },

  // Where a value was read from. Values worked out from another use that one's source.
  sourceOf: function(column, key) {
    const derivedFrom = { calories: "kilojoules", kilojoules: "calories", salt: "sodium", sodium: "salt" };
    let entry = column.values[key] || column.values[derivedFrom[key]];
    return entry !== undefined ? entry.source : undefined;
  },

  // ---- Review ----

  // The review screen: the photo with highlights above a scrollable list of values. It opens
  // before the photo has been read; the returned controller fills it in.
  openReview: function(uri) {
    const strings = this.strings();
    const units = app.Nutriments.getNutrimentUnits();
    const order = app.Nutriments.getNutriments();
    const svgNs = "http://www.w3.org/2000/svg";
    let open = true;
    let result;
    let image = { uri: uri };
    let columns = [];
    let selected = 0;
    let selectedKey;
    let tableBox;   // the photo zooms to the table once it has been found

    let popupEl = document.createElement("div");
    popupEl.className = "popup nutrition-review";
    popupEl.innerHTML = `
      <div class="view">
        <div class="page">
          <div class="navbar">
            <div class="navbar-bg"></div>
            <div class="navbar-inner">
              <div class="left"><a href="#" class="link icon-only popup-close"><i class="icon material-icons">close</i></a></div>
              <div class="title"></div>
              <div class="right"><a href="#" class="link icon-only disabled" id="scan-apply"><i class="icon material-icons">done</i></a></div>
            </div>
          </div>
          <div class="page-content">
            <div class="scan-image"><div class="preloader color-white"></div></div>
            <div class="scan-list">
              <div class="block scan-status"><span class="preloader"></span><span class="scan-status-text"></span></div>
              <div class="block" id="scan-columns" style="display: none;"><div class="segmented"></div></div>
              <div class="list inline-labels no-hairlines-md">
                <ul id="scan-serving"></ul>
                <ul id="scan-values"></ul>
                <ul id="scan-more" style="display: none;"><li><a href="#" class="list-button"></a></li></ul>
              </div>
            </div>
          </div>
        </div>
      </div>`;
    popupEl.querySelector(".title").innerText = strings["scan-label"] || "Scan Nutrition Label";
    let applyButton = popupEl.querySelector("#scan-apply");

    // The photo, with outlines drawn in its own pixel coordinates
    let imageWrap = popupEl.querySelector(".scan-image");
    let svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    let photo = document.createElementNS(svgNs, "image");
    let ocrLayer = document.createElementNS(svgNs, "g");
    let foundLayer = document.createElementNS(svgNs, "g");
    let highlightLayer = document.createElementNS(svgNs, "g");
    svg.append(photo, ocrLayer, foundLayer, highlightLayer);

    let polygon = (box, className) => {
      let p = document.createElementNS(svgNs, "polygon");
      let c = Math.cos(box.angle || 0);
      let s = Math.sin(box.angle || 0);
      let points = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
        let x = box.cx + u * box.w / 2 * c - v * box.h / 2 * s;
        let y = box.cy + u * box.w / 2 * s + v * box.h / 2 * c;
        return x.toFixed(1) + "," + y.toFixed(1);
      });
      p.setAttribute("points", points.join(" "));
      p.setAttribute("class", className);
      p.setAttribute("vector-effect", "non-scaling-stroke");
      return p;
    };
    let shifted = (box, dx, dy) => Object.assign({}, box, { cx: box.cx + dx, cy: box.cy + dy });

    // Zoom the photo so a box fills the middle of it, by animating the SVG's view box (lines
    // keep their width at any zoom)
    let view;
    let animation;
    let setView = (v) => {
      view = v;
      svg.setAttribute("viewBox", v.map((n) => n.toFixed(1)).join(" "));
    };
    // fill: the share of the view's height the box may take (a row: half; the table: nearly all)
    let zoomTo = (box, fill) => {
      if (image.width === undefined)
        return;
      let target = [0, 0, image.width, image.height];
      if (box !== undefined) {
        let ww = imageWrap.clientWidth;
        let wh = imageWrap.clientHeight;
        let c = Math.abs(Math.cos(box.angle || 0));
        let s = Math.abs(Math.sin(box.angle || 0));
        let bw = box.w * c + box.h * s;
        let bh = box.w * s + box.h * c;
        // View width in image pixels: the box fills 92% of the width or `fill` of the height
        let vw = Math.max(bw / 0.92, bh / (fill || 0.5) * ww / wh);
        vw = Math.min(image.width, Math.max(vw, image.width / 6));
        let vh = vw * wh / ww;
        target = [box.cx - vw / 2, box.cy - vh / 2, vw, vh];
      }
      let from = view || [0, 0, image.width, image.height];
      let start = performance.now();
      cancelAnimationFrame(animation);
      let step = (now) => {
        let t = Math.min(1, (now - start) / 250);
        let e = 1 - Math.pow(1 - t, 3);
        setView(from.map((f, i) => f + (target[i] - f) * e));
        if (t < 1)
          animation = requestAnimationFrame(step);
      };
      animation = requestAnimationFrame(step);
    };

    // Outline and zoom to a nutrient's row, whether its name or its value was chosen
    let highlight = (key) => {
      selectedKey = key;
      highlightLayer.innerHTML = "";
      popupEl.querySelectorAll("#scan-values li").forEach((li) => li.classList.toggle("selected", li.dataset.key === key));
      let source = key !== undefined && columns[selected] ? this.sourceOf(columns[selected], key) : undefined;
      let row = source !== undefined ? this.rowBox(source) : undefined;
      if (row !== undefined)
        highlightLayer.appendChild(polygon(row, "row-box"));
      if (row !== undefined)
        zoomTo(row);
      else
        zoomTo(tableBox, 0.95);
    };

    imageWrap.addEventListener("click", () => highlight(undefined));

    let zoomToTable = (r) => {
      if (r.bounds === undefined)
        return;
      let b = r.bounds;
      let m = 0.04 * Math.max(b.x1 - b.x0, b.y1 - b.y0);
      tableBox = { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2, w: b.x1 - b.x0 + 2 * m, h: b.y1 - b.y0 + 2 * m, angle: 0 };
      if (selectedKey === undefined)
        zoomTo(tableBox, 0.95);
    };

    let moreButton = popupEl.querySelector("#scan-more .list-button");
    moreButton.innerText = app.strings["foods-meals-recipes"]["show-more-nutriments"] || "Show more nutriments";
    moreButton.addEventListener("click", (e) => {
      e.preventDefault();
      // Keep anything already typed in
      let typed = {};
      for (let key in inputs)
        typed[key] = inputs[key].value;
      showAll = true;
      render();
      for (let key in typed) {
        if (inputs[key] !== undefined)
          inputs[key].value = typed[key];
      }
    });

    let inputs = {};
    let servingInputs = {};
    let partial = false;
    const visibility = app.Settings.getField("nutrimentVisibility") || {};
    const energyUnit = app.Settings.get("units", "energy");
    let showAll = false;
    let shown = (key) => showAll || visibility[key] === true || units[key] === energyUnit;
    let addRow = (ul, labelText, value, type, key) => {
      let li = document.createElement("li");
      li.className = "item-content item-input";
      li.innerHTML = `<div class="item-inner"><div class="item-title item-label"></div><div class="item-input-wrap"><input class="align-end"></div></div>`;
      li.querySelector(".item-title").innerText = labelText;
      let input = li.querySelector("input");
      input.type = type;
      if (type == "number")
        input.step = "any";
      input.value = value === undefined ? "" : value;
      input.disabled = partial;
      if (key !== undefined) {
        li.dataset.key = key;
        li.querySelector(".item-title").addEventListener("click", () => highlight(key));
        input.addEventListener("focus", () => highlight(key));
      }
      ul.appendChild(li);
      return input;
    };

    let segmented = popupEl.querySelector(".segmented");
    let render = () => {
      segmented.querySelectorAll(".button").forEach((b, i) => b.classList.toggle("button-active", i == selected));
      let column = columns[selected];

      let servingUl = popupEl.querySelector("#scan-serving");
      servingUl.innerHTML = "";
      servingInputs = {};
      if (column.amount !== undefined) {
        servingInputs.portion = addRow(servingUl, strings["serving-size"] || "Serving Size", column.amount, "number");
        servingInputs.unit = addRow(servingUl, strings["serving-unit"] || "Serving Unit", column.unit || "", "text");
      }

      let valuesUl = popupEl.querySelector("#scan-values");
      valuesUl.innerHTML = "";
      inputs = {};
      // Every nutrient the user shows (plus any that were read), so missing ones can be filled in
      let values = this.columnValues(column);
      order.forEach((key) => {
        if (values[key] === undefined && !shown(key))
          return;
        let name = app.strings.nutriments[key] || key;
        let unit = app.strings["unit-symbols"][units[key]] || units[key];
        inputs[key] = addRow(valuesUl, app.Utils.tidyText(name, 25) + (unit ? " (" + unit + ")" : ""), values[key], "number", key);
      });

      // Like the food editor, the rest of the nutrients are behind a button
      let more = popupEl.querySelector("#scan-more");
      more.style.display = showAll || order.every((key) => shown(key) || values[key] !== undefined) ? "none" : "";

      // Outline every value read for this column
      foundLayer.innerHTML = "";
      for (let key in column.values) {
        let source = column.values[key].source;
        if (source && source.value)
          foundLayer.appendChild(polygon(source.value, "found"));
      }
      highlight(selectedKey !== undefined && inputs[selectedKey] !== undefined ? selectedKey : undefined);
    };

    document.querySelector("#app").appendChild(popupEl);
    popupEl.querySelectorAll(".preloader").forEach((el) => app.f7.preloader.init(el));
    let popup = app.f7.popup.create({
      el: popupEl,
      on: {
        closed: (p) => {
          open = false;
          p.destroy();
          popupEl.remove();
          this.review = undefined;
        }
      }
    });
    this.review = popup;

    applyButton.addEventListener("click", (e) => {
      e.preventDefault();
      if (result === undefined)
        return;
      let values = {};
      for (let key in inputs) {
        let v = parseFloat(inputs[key].value);
        if (!isNaN(v))
          values[key] = v;
      }
      let serving;
      if (servingInputs.portion !== undefined && servingInputs.portion.value !== "")
        serving = { amount: parseFloat(servingInputs.portion.value), unit: servingInputs.unit.value.trim() };
      this.apply(values, serving, columns[selected].basis);
      popup.close();
      this.addNutritionImage(result, image);
    });

    popup.open();

    return {
      isOpen: () => open,

      setImage: (info) => {
        image.width = info.width;
        image.height = info.height;
        setView([0, 0, info.width, info.height]);
        photo.setAttribute("href", info.preview);
        photo.setAttribute("width", info.width);
        photo.setAttribute("height", info.height);
        imageWrap.innerHTML = "";
        imageWrap.appendChild(svg);
      },

      // Text found but not read yet
      addBoxes: (boxes, dx, dy) => {
        boxes.forEach((b) => ocrLayer.appendChild(polygon(shifted(b, dx, dy), "ocr-box")));
      },

      // Text that has been read
      addLines: (lines, dx, dy) => {
        lines.forEach((l) => ocrLayer.appendChild(polygon(shifted(l, dx, dy), "ocr-line")));
      },

      // The first read of the whole photo is done: zoom in on the table it found
      showTable: (r) => zoomToTable(r),

      clearBoxes: () => {
        ocrLayer.innerHTML = "";
      },

      showMessage: (message) => {
        popupEl.querySelector(".scan-status .preloader").style.display = "none";
        popupEl.querySelector(".scan-status-text").innerText = message;
        ocrLayer.classList.add("done");
      },

      // isPartial: values so far, while the photo is still being read (shown but not editable)
      setResult: (r, img, isPartial) => {
        partial = isPartial === true;
        if (img !== undefined)
          Object.assign(image, img);
        let previous = columns[selected];
        columns = r.columns;
        selected = Math.max(0, columns.indexOf(this.bestColumn(r)));
        if (previous !== undefined && previous.basis !== undefined) {
          let same = columns.findIndex((c) => c.basis == previous.basis);
          if (same >= 0)
            selected = same;
        }
        if (!partial)
          zoomToTable(r);
        if (!partial) {
          result = r;
          popupEl.querySelector(".scan-status").style.display = "none";
          ocrLayer.classList.add("done");
          applyButton.classList.remove("disabled");
        }

        popupEl.querySelector("#scan-columns").style.display = columns.length > 1 ? "" : "none";
        segmented.innerHTML = "";
        columns.forEach((column, i) => {
          let button = document.createElement("a");
          button.href = "#";
          button.className = "button";
          button.innerText = this.columnTitle(column, i);
          button.addEventListener("click", (e) => {
            e.preventDefault();
            selected = i;
            render();
          });
          segmented.appendChild(button);
        });
        render();
      }
    };
  },

  // One box around a nutrient's row (its label and its value). The row runs from the label to
  // the value, which gives its direction more reliably than either box on its own.
  rowBox: function(source) {
    let boxes = [source.label, source.value].filter((b) => b !== undefined);
    if (boxes.length == 0)
      return undefined;
    let ref = source.value || source.label;
    let angle = boxes.length == 2
      ? Math.atan2(source.value.cy - source.label.cy, source.value.cx - source.label.cx)
      : ref.angle || 0;
    if (Math.abs(angle) > Math.PI / 4)
      angle = ref.angle || 0;
    let c = Math.cos(angle);
    let s = Math.sin(angle);
    let us = [];
    let vs = [];
    boxes.forEach((b) => {
      // Each box's own extent along the row and across it
      let hw = b.w / 2;
      let hh = b.h / 2;
      let x = b.cx - ref.cx;
      let y = b.cy - ref.cy;
      let u = x * c + y * s;
      let v = -x * s + y * c;
      us.push(u - hw, u + hw);
      vs.push(v - hh, v + hh);
    });
    let u0 = Math.min.apply(null, us);
    let u1 = Math.max.apply(null, us);
    let v0 = Math.min.apply(null, vs);
    let v1 = Math.max.apply(null, vs);
    let pad = (v1 - v0) * 0.15;
    let uc = (u0 + u1) / 2;
    let vc = (v0 + v1) / 2;
    return {
      cx: ref.cx + uc * c - vc * s,
      cy: ref.cy + uc * s + vc * c,
      w: u1 - u0 + 2 * pad,
      h: v1 - v0 + pad,
      angle: angle
    };
  },

  // Fills the food editor's fields. Old values are updated too, so linked serving changes scale
  // from the scanned values.
  apply: function(values, serving, basis) {
    const el = app.FoodEditor.el;

    if (serving !== undefined && !isNaN(serving.amount)) {
      el.portion.value = serving.amount;
      el.portion.oldValue = serving.amount;
      if (serving.unit !== "" && !el.unit.disabled)
        el.unit.value = serving.unit;
    }

    for (let key in values) {
      let input = document.querySelector("#food-edit-form #nutrition #" + CSS.escape(key));
      if (input === null)
        continue;
      input.value = values[key];
      input.oldValue = values[key];
      let li = input.closest("li");
      if (li !== null)
        li.classList.remove("item-hidden");
    }

    // When the food will be uploaded to Open Food Facts, say what the values are per
    let radio = document.querySelector("#food-edit-form #" + (basis == "serving" ? "per_serving" : "per_100g"));
    if (radio !== null && basis !== undefined)
      radio.checked = true;
  },

  // For uploads to Open Food Facts, use a straightened crop of the table as the nutrition photo
  addNutritionImage: async function(result, image) {
    if (app.FoodEditor.scan !== true || result.bounds === undefined)
      return;
    try {
      let b = result.bounds;
      let margin = 0.06 * Math.max(b.x1 - b.x0, b.y1 - b.y0);
      let box = {
        cx: (b.x0 + b.x1) / 2,
        cy: (b.y0 + b.y1) / 2,
        w: b.x1 - b.x0 + 2 * margin,
        h: b.y1 - b.y0 + 2 * margin,
        angle: result.angle || 0
      };
      let dataUrl = await PaddleOcr.cropImage(image.uri, box, 2000);
      let blob = await (await fetch(dataUrl)).blob();

      const index = 1; // "nutrition" in the Open Food Facts image fields
      await app.FoodEditor.addPicture(index, blob);
      app.FoodImages.insertImageEl(app.FoodEditor.el.addPhoto[index], app.FoodEditor.el.photoHolder[index],
        URL.createObjectURL(blob), true, () => app.FoodEditor.removePicture(index));
    } catch (e) {
      console.error(e);
    }
  }
};
