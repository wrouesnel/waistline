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
  Turns OCR text boxes from a photo of a nutrition table into nutrient values.

  Input is a list of recognised text lines: {text, cx, cy, w, h, angle}, with the centre, size and
  rotation (radians) of each line's box in image pixels. The parser:

  1. Rotates all boxes by the median text angle so table rows are horizontal.
  2. Splits each line into number tokens (with units) and label text.
  3. Matches label text against nutrient names in several languages.
  4. Groups the numbers into rows and columns, and lines the rows up with the labels in
     top-to-bottom order, so labels that sit slightly above or below their values still match.
  5. Reads the column headers to decide whether each column is per 100 g/ml or per serving.

  It has no DOM dependencies, so it can be tested outside the app.
*/

app.NutritionLabelParser = {

  // Nutrient names, normalised (lower case, no accents). Longer, more specific names win.
  synonyms: {
    "energy": ["energeticka hodnota", "energijska vrednost", "valoare energetica", "energiatartalom", "energiaa", "energiarvo", "energy", "energie", "energia", "energi", "valeur energetique", "valor energetico", "valore energetico",
      "brennwert", "energetische waarde", "wartosc energetyczna", "calories", "kalorien", "calorias"],
    "fat": ["tuky", "mascobe", "grasimi", "zsir", "rasva", "rasvaa", "fedt", "maščobe", "fat", "total fat", "fat total", "fett", "matieres grasses", "lipides", "grassi", "grasas", "lipidos",
      "gordura", "gorduras", "gordura total", "vet", "vetten", "tluszcz", "materia grassa", "grassi totali"],
    "saturated-fat": ["nasycene mastne kyseliny", "nasicene mascobe", "nasicene mascobne kisline", "acizi grasi saturati", "telitett zsirsavak", "tyydyttyneet rasvat", "tyydyttynytta rasvaa", "mattat fett", "mattade fettsyror", "mettede fettsyrer", "maettede fedtsyrer", "nasycene", "saturated", "saturates", "saturated fat", "sat fat", "gesattigte fettsauren", "gesattigte",
      "acides gras satures", "satures", "acidi grassi saturi", "saturi", "saturadas", "grasas saturadas",
      "acidos grasos saturados", "saturados", "gordura saturada", "verzadigd", "verzadigde vetzuren", "nasycone",
      "kwasy tluszczowe nasycone"],
    "trans-fat": ["trans", "trans fat", "trans fatty acids", "trans fats", "acides gras trans", "grasas trans"],
    "monounsaturated-fat": ["monounsaturated", "monounsaturates", "mono unsaturates", "monounsaturated fat",
      "einfach ungesattigte fettsauren", "acides gras mono insatures", "monoinsaturi", "monoinsaturadas"],
    "polyunsaturated-fat": ["polyunsaturated", "polyunsaturates", "poly unsaturates", "polyunsaturated fat",
      "mehrfach ungesattigte fettsauren", "acides gras poly insatures", "polinsaturi", "poliinsaturadas"],
    "cholesterol": ["cholesterol", "cholesterin", "colesterol", "colesterolo"],
    "carbohydrates": ["sacharidy", "ogljikovi hidrati", "szenhidrat", "hiilihydraatit", "hiilihydraattia", "kulhydrat", "kolhydrat", "karbohydrat", "carbohydrate", "carbohydrates", "total carbohydrate", "carbohydrate total", "carbs",
      "kohlenhydrate", "glucides", "carboidrati", "hidratos de carbono", "carbohidratos", "koolhydraten",
      "weglowodany", "hidratos de carbono totales"],
    "sugars": ["cukry", "sladkorji", "zaharuri", "cukrok", "sokerit", "sokereita", "sukkerarter", "sockerarter", "sugars", "sugar", "total sugars", "zucker", "sucres", "zuccheri", "azucares", "acucares", "suikers",
      "cukry"],
    "fiber": ["vlaknina", "prehranske vlaknine", "fibre alimentare", "rost", "ravintokuitu", "kostfibre", "kostfiber", "fibre", "fiber", "dietary fiber", "dietary fibre", "ballaststoffe", "fibres alimentaires", "fibres",
      "fibre alimentari", "fibra", "fibra alimentaria", "fibra alimentar", "vezels", "voedingsvezel", "blonnik"],
    "proteins": ["bilkoviny", "beljakovine", "proteine", "feherje", "proteiini", "proteiinia", "protein", "proteins", "eiweiss", "proteines", "proteine", "proteinas", "eiwitten", "bialko"],
    "salt": ["sul", "sare", "so", "suola", "suolaa", "salt", "salz", "sel", "sale", "sal", "zout", "sol"],
    "sodium": ["sodium", "natrium", "sodio"],
    "potassium": ["potassium", "kalium", "potasio", "potassio"],
    "calcium": ["calcium", "calcio", "kalzium"],
    "iron": ["iron", "eisen", "fer", "ferro", "hierro"],
    "magnesium": ["magnesium", "magnesio"],
    "lactose": ["lactose", "lattosio", "lactosa", "laktose"],
    "sucrose": ["sucrose", "saccharose"],
    "glucose": ["glucose", "glukose"],
    "fructose": ["fructose", "fruktose"],
    "caffeine": ["caffeine", "koffein", "cafeine"],
    "alcohol": ["alcohol", "alkohol"],
    "vitamin-a": ["vitamin a", "vitamine a", "vitamina a"],
    "vitamin-c": ["vitamin c", "vitamine c", "vitamina c"],
    "vitamin-d": ["vitamin d", "vitamine d", "vitamina d"],
    "vitamin-e": ["vitamin e", "vitamine e", "vitamina e"],
    "vitamin-b1": ["vitamin b1", "thiamin", "thiamine", "tiamina"],
    "vitamin-b2": ["vitamin b2", "riboflavin", "riboflavine", "riboflavina"],
    "vitamin-pp": ["niacin", "niacine", "niacina", "vitamin b3"],
    "vitamin-b6": ["vitamin b6", "vitamine b6", "vitamina b6"],
    "vitamin-b9": ["folate", "folic acid", "folsaure", "acide folique", "acido folico", "vitamin b9"],
    "vitamin-b12": ["vitamin b12", "vitamine b12", "vitamina b12"],
    "zinc": ["zinc", "zink"],
    "phosphorus": ["phosphorus", "phosphor", "phosphore", "fosforo"]
  },

  // Order of the mandatory nutrients on EU tables. Used to name a row whose label couldn't be
  // read, when it sits between two rows that were matched.
  canonicalOrder: ["energy", "fat", "saturated-fat", "carbohydrates", "sugars", "fiber", "proteins", "salt"],

  unitFactors: { "g": 1, "mg": 0.001, "µg": 0.000001 },

  // Nutrients always given in grams
  gramNutrients: ["fat", "saturated-fat", "trans-fat", "monounsaturated-fat", "polyunsaturated-fat", "carbohydrates",
    "sugars", "fiber", "proteins", "salt", "lactose", "sucrose", "glucose", "fructose", "alcohol"],

  normalise: function(text) {
    return text.toLowerCase()
      .replace(/ß/g, "ss")
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  },

  levenshtein: function(a, b) {
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let cur = [i];
      for (let j = 1; j <= b.length; j++)
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[b.length];
  },

  // Returns {key, score} for the nutrient a piece of label text names, or undefined
  matchNutrient: function(text, extraSynonyms) {
    let best;
    let parts = text.split(/[\/|]/).map((p) => this.normalise(p.replace(/^[\s\-–—•·*]+/, ""))).filter((p) => p.length > 1);

    for (let part of parts) {
      // Drop "of which" style prefixes and numbers
      let words = part.replace(/\b(of which|dont|davon|di cui|de las cuales|de los cuales|waarvan|including|incl|w tym|des quels|dos quais)\b/g, " ")
        .replace(/\b\d+\b/g, " ").replace(/\s+/g, " ").trim();
      if (words.length < 2)
        continue;

      for (let key in this.synonyms) {
        let names = this.synonyms[key].concat((extraSynonyms && extraSynonyms[key]) || []);
        for (let name of names) {
          let score = 0;
          if (words == name)
            score = 1;
          else if ((" " + words + " ").includes(" " + name + " "))
            score = 0.9;
          else if (name.length >= 4 && Math.abs(words.length - name.length) <= 3)
            score = 1 - this.levenshtein(words, name) / Math.max(words.length, name.length);
          else if (name.length >= 5) {
            // Compare against each run of words the same length as the name, to allow for OCR noise
            let w = words.split(" ");
            let n = name.split(" ").length;
            for (let i = 0; i + n <= w.length; i++) {
              let chunk = w.slice(i, i + n).join(" ");
              score = Math.max(score, 0.95 * (1 - this.levenshtein(chunk, name) / Math.max(chunk.length, name.length)));
            }
          }
          // Prefer longer, more specific names ("saturated fat" over "fat")
          score += name.length / 1000;
          if (score >= 0.75 && (best === undefined || score > best.score))
            best = { key: key, score: score };
        }
      }
    }
    return best;
  },

  // Splits one OCR line into number tokens and text, estimating each token's x position
  tokenise: function(line) {
    let tokens = [];
    // A zero is often read as the letter O: "Og", "O,5g", "Fat Og". Capital O before a unit, or
    // a lone "og" (which is also a word in some languages, so only on its own)
    let text = line.text
      .replace(/(^|[\s(\/<])O(?=[.,]?\d*\s?(g|mg|µg|kj|kcal)\b)/g, "$10")
      .replace(/^(\s*)o(\s?(g|mg)\s*)$/i, "$10$2");
    // Numbers joined to letters ("Vitamin B12", "Omega-3") are part of a name, not a value
    let re = /([<>≤~]?)\s*(?<![A-Za-z][-‐]?)(\d+(?:[.,]\d+)?)\s*(kj|k3|kl|kcal|cal|ca|k|mg|ing|rng|µg|μg|ug|mcg|g|ml|%)?(?![a-z])/gi;
    let m;
    let last = 0;
    let labelParts = [];

    while ((m = re.exec(text)) !== null) {
      if (m.index > last)
        labelParts.push(text.slice(last, m.index));
      last = m.index + m[0].length;

      // Units, including common OCR misreads
      let unit = (m[3] || "").toLowerCase();
      unit = { "cal": "kcal", "ca": "kcal", "k": "kj", "k3": "kj", "kl": "kj", "ing": "mg", "rng": "mg", "μg": "µg", "ug": "µg", "mcg": "µg" }[unit] || unit;

      // "2,190 kJ" is a thousands separator, "0,190" a decimal comma
      let digits = m[2];
      if (/^[1-9]\d?,\d{3}$/.test(digits) && (unit == "kj" || unit == "kcal" || unit == "mg"))
        digits = digits.replace(",", "");

      let mid = (m.index + m[0].length / 2) / Math.max(text.length, 1);
      let raw = m[0].trim();
      let start = m.index + m[0].indexOf(raw);
      tokens.push({
        box: this.subBox(line, start, raw.length),
        raw: m[0].trim(),
        digits: digits,
        value: parseFloat(digits.replace(",", ".")),
        unit: unit,
        pct: unit == "%" || /^\s*\)?%/.test(text.slice(last)),
        x: line.x0 + mid * line.w,
        y: line.y,
        h: line.h
      });
    }
    if (last < text.length)
      labelParts.push(text.slice(last));

    let label = labelParts.join(" ").replace(/[()\[\]:*]/g, " ").trim();
    return { tokens: tokens, label: /[a-zA-ZÀ-ɏ]{2,}/.test(label) ? label : "" };
  },

  // Box (image coordinates) of the characters [start, start + length) of an OCR line
  subBox: function(line, start, length) {
    let n = Math.max(line.text.length, 1);
    let angle = line.angle || 0;
    let u = ((start + length / 2) / n - 0.5) * line.w;
    return {
      cx: line.cx + u * Math.cos(angle),
      cy: line.cy + u * Math.sin(angle),
      w: Math.max(length / n * line.w, line.h),
      h: line.h,
      angle: angle
    };
  },

  lineBox: function(line) {
    return { cx: line.cx, cy: line.cy, w: line.w, h: line.h, angle: line.angle || 0 };
  },

  median: function(values) {
    if (values.length == 0)
      return 0;
    let s = values.slice().sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  },

  // Groups items with a .y into rows, where each row's items are within tol of the row's mean
  clusterRows: function(items, tol) {
    let rows = [];
    items.slice().sort((a, b) => a.y - b.y).forEach((item) => {
      let row = rows[rows.length - 1];
      if (row !== undefined && Math.abs(item.y - row.y) <= tol) {
        row.items.push(item);
        row.y = row.items.reduce((s, i) => s + i.y, 0) / row.items.length;
      } else {
        rows.push({ y: item.y, items: [item] });
      }
    });
    return rows;
  },

  // Reads a column header such as "100 g", "per 100ml", "Per serve", "(20 g)" or "/51g"
  parseHeader: function(text) {
    let t = this.normalise(text.replace(/(\d),(\d)/g, "$1.$2"));
    let m = t.match(/\b100 ?(g|ml)\b/) || t.match(/\b1009\b/);
    if (m)
      return { basis: "100", unit: m[1] || "g" };
    m = t.match(/\b(\d+(?:\.\d+)?) ?(g|ml)\b/);
    if (m)
      return { basis: "serving", amount: parseFloat(m[1]), unit: m[2] };
    if (/\b(serv|serve|serving|portion|porcion|porzione|portie|portionen|biscuit|slice|piece|tranche)/.test(t))
      return { basis: "serving" };
    return undefined;
  },

  parse: function(lines, extraSynonyms) {
    lines = lines.filter((l) => l.text && l.text.trim() !== "");
    if (lines.length == 0)
      return { columns: [] };

    // 1. Straighten: rotate every box centre by the median text angle
    let angle = this.median(lines.map((l) => l.angle || 0));
    let ca = Math.cos(-angle);
    let sa = Math.sin(-angle);
    lines = lines.map((l) => {
      let x = l.cx * ca - l.cy * sa;
      let y = l.cx * sa + l.cy * ca;
      return Object.assign({}, l, { x: x, y: y, x0: x - l.w / 2 });
    });
    let lineHeight = this.median(lines.map((l) => l.h));

    // 2. Tokenise into values and nutrient labels
    let values = [];
    let labels = [];
    let unmatched = [];
    lines.forEach((line) => {
      let t = this.tokenise(line);
      let match = t.label !== "" ? this.matchNutrient(t.label, extraSynonyms) : undefined;
      if (match)
        labels.push({ key: match.key, score: match.score, y: line.y, x: line.x0, text: t.label, line: line });
      else if (t.label !== "" && t.tokens.length == 0)
        unmatched.push({ line: line, text: t.label });
      // Column headers ("100 g", "(20 g)", "per serve") look like values, so keep them out
      line.isHeader = match === undefined && this.isHeaderLine(line.text);
      if (!line.isHeader) {
        t.tokens.forEach((tok) => tok.line = line);
        values = values.concat(t.tokens.filter((tok) => !tok.pct && tok.unit != "ml"));
      }
    });

    // A label can wrap onto a second line ("Matières" / "grasses"): try each unmatched piece of
    // text with the one directly below it
    unmatched.forEach((a) => {
      if (a.used)
        return;
      let b = unmatched.find((o) => !o.used && o !== a && o.line.y > a.line.y &&
        o.line.y - a.line.y < a.line.h * 1.6 && Math.abs(o.line.x0 - a.line.x0) < a.line.h * 3);
      if (b === undefined)
        return;
      let match = this.matchNutrient(a.text + " " + b.text, extraSynonyms);
      if (match === undefined || match.score < 0.85)
        return;
      a.used = b.used = true;
      labels.push({ key: match.key, score: match.score, y: (a.line.y + b.line.y) / 2, x: Math.min(a.line.x0, b.line.x0),
        text: a.text + " " + b.text, line: a.line });
    });

    // Energy is identified by its unit, so it doesn't need a label
    let isEnergy = (tok) => tok.unit == "kj" || tok.unit == "kcal";
    let energyLabels = labels.filter((l) => l.key == "energy");
    if (values.some(isEnergy))
      labels = labels.filter((l) => l.key != "energy");

    // 3. Split side-by-side tables into panels, one per column of labels
    let panels = this.findPanels(labels, lineHeight);
    let panelColumns = panels.map((panel) => {
      let tokens = values.filter((tok) => tok.x > panel.x0 && tok.x < panel.x1);
      let panelLabels = labels.filter((l) => l.x >= panel.x0 - lineHeight && l.x < panel.x1);
      return this.parsePanel(panelLabels, tokens.filter((t) => !isEnergy(t)), tokens.filter(isEnergy), lines, lineHeight, energyLabels);
    });

    // 4. Merge panels: the nth column of each panel has the same basis (per serving, per 100 g)
    let count = Math.max.apply(null, panelColumns.map((c) => c.length).concat([0]));
    let result = [];
    for (let i = 0; i < count; i++) {
      let merged = { values: {}, header: { text: "" } };
      panelColumns.forEach((cols) => {
        let col = cols[i];
        if (col === undefined)
          return;
        if (merged.x === undefined)
          merged.x = col.x;
        for (let k in col.values) {
          if (merged.values[k] === undefined)
            merged.values[k] = col.values[k];
        }
        if (merged.header.parsed === undefined && col.header.parsed !== undefined)
          merged.header = col.header;
        else if (merged.header.text === "")
          merged.header = col.header;
      });
      result.push(merged);
    }

    result.forEach((col) => this.fixEnergy(col.values));
    result = result.filter((col) => Object.keys(col.values).length >= 2);
    this.guessBases(result, lines);

    // Drop sparse columns of unknown basis (stray numbers) when the table has real columns
    let most = Math.max.apply(null, result.map((c) => Object.keys(c.values).length).concat([0]));
    if (result.some((c) => c.basis !== undefined))
      result = result.filter((c) => c.basis !== undefined || Object.keys(c.values).length * 2 >= most);

    return { columns: result, bounds: this.tableBounds(labels, values, lines), angle: angle };
  },

  // Bounding box (image pixels) of the nutrient labels and the values beside them, used to
  // zoom in on a small table and read it again at a higher resolution
  tableBounds: function(labels, values, lines) {
    // Only labels paired with a row of values: nutrient words in the ingredients don't count
    labels = labels.filter((l) => l.used);
    if (labels.length == 0)
      return undefined;
    let used = new Set(labels.map((l) => l.line));
    let labelTop = Math.min.apply(null, labels.map((l) => l.y));
    let labelBottom = Math.max.apply(null, labels.map((l) => l.y));
    let lineHeight = this.median(lines.map((l) => l.h));
    values.forEach((tok) => {
      if (tok.y >= labelTop - lineHeight * 2 && tok.y <= labelBottom + lineHeight)
        used.add(tok.line);
    });
    lines.forEach((l) => {
      if (l.isHeader && l.y >= labelTop - lineHeight * 4 && l.y <= labelBottom)
        used.add(l);
    });
    if (used.size < 3)
      return undefined;
    let b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    used.forEach((l) => {
      let hw = l.w / 2 * Math.abs(Math.cos(l.angle || 0)) + l.h / 2 * Math.abs(Math.sin(l.angle || 0));
      let hh = l.w / 2 * Math.abs(Math.sin(l.angle || 0)) + l.h / 2 * Math.abs(Math.cos(l.angle || 0));
      b.x0 = Math.min(b.x0, l.cx - hw);
      b.x1 = Math.max(b.x1, l.cx + hw);
      b.y0 = Math.min(b.y0, l.cy - hh);
      b.y1 = Math.max(b.y1, l.cy + hh);
    });
    return b;
  },

  // Labels whose left edges line up form a label column; each label column starts a panel
  // that runs to the next label column on the right
  findPanels: function(labels, lineHeight) {
    let xs = labels.map((l) => l.x).sort((a, b) => a - b);
    let groups = [];
    xs.forEach((x) => {
      let g = groups[groups.length - 1];
      if (g !== undefined && x - g[g.length - 1] <= lineHeight * 3)
        g.push(x);
      else
        groups.push([x]);
    });
    let starts = groups.filter((g) => g.length >= 2).map((g) => g[0]);
    if (starts.length == 0)
      return [{ x0: -Infinity, x1: Infinity }];
    return starts.map((x, i) => ({
      x0: i == 0 ? -Infinity : x - lineHeight,
      x1: i + 1 < starts.length ? starts[i + 1] - lineHeight : Infinity
    }));
  },

  parsePanel: function(labels, nutrientTokens, energyTokens, lines, lineHeight, energyLabels) {
    // Rows of values, lined up with the label rows in top-to-bottom order
    let valueRows = this.clusterRows(nutrientTokens, lineHeight * 0.5);
    let energyRows = this.clusterRows(energyTokens, lineHeight * 0.5);
    let pairs = this.alignRows(labels.slice().sort((a, b) => a.y - b.y), valueRows, lineHeight);

    let rowsByKey = {};
    let labelByKey = {};
    pairs.forEach((p) => {
      if (rowsByKey[p.label.key] === undefined) {
        rowsByKey[p.label.key] = p.row;
        labelByKey[p.label.key] = p.label.line;
        p.label.used = true;
      }
    });
    this.inferMissingRows(pairs, valueRows, rowsByKey);

    // Columns come only from values in rows that were matched, so stray numbers elsewhere
    // on the pack can't join or split them
    let tableTokens = [];
    for (let key in rowsByKey)
      tableTokens = tableTokens.concat(rowsByKey[key].items.map((tok) => Object.assign({ key: key }, tok)));
    energyRows.forEach((row) => tableTokens = tableTokens.concat(row.items));
    let columns = this.clusterColumns(tableTokens, lineHeight);
    if (columns.length == 0)
      return [];

    let result = columns.map((col) => ({ x: col.x, values: {}, minY: Infinity }));
    let colOf = (tok) => {
      let best = 0;
      columns.forEach((c, i) => {
        if (Math.abs(tok.x - c.x) < Math.abs(tok.x - columns[best].x))
          best = i;
      });
      return result[best];
    };

    // Does this table print units next to its values (rather than in a column of their own)?
    let rowTokens = [];
    for (let key in rowsByKey)
      rowTokens = rowTokens.concat(rowsByKey[key].items);
    let inlineUnits = rowTokens.length >= 4 && rowTokens.filter((t) => t.unit !== "").length * 2 >= rowTokens.length;

    for (let key in rowsByKey) {
      let row = rowsByKey[key];
      let rowUnits = row.items.map((t) => t.unit).filter((u) => u !== "");
      row.items.forEach((tok) => {
        let unit = tok.unit;
        let value = tok.value;
        // "g" is often read as "9": 129 -> 12g, 4.19 -> 4.1g, 09 -> 0g
        if (unit === "" && /\d9$/.test(tok.digits) &&
            (rowUnits.includes("g") || (inlineUnits && this.gramNutrients.includes(key)))) {
          value = parseFloat(tok.digits.slice(0, -1).replace(",", "."));
          unit = "g";
        }
        let col = colOf(tok);
        if (col.values[key] === undefined) {
          col.values[key] = {
            value: value,
            unit: unit || undefined,
            source: { value: tok.box, label: labelByKey[key] ? this.lineBox(labelByKey[key]) : undefined }
          };
          col.minY = Math.min(col.minY, tok.y);
        }
      });
    }

    energyRows.forEach((row) => {
      let label = (energyLabels || []).filter((l) => Math.abs(l.y - row.y) < lineHeight * 2.5)
        .sort((a, b) => Math.abs(a.y - row.y) - Math.abs(b.y - row.y))[0];
      row.items.forEach((tok) => {
        let col = colOf(tok);
        let key = tok.unit == "kj" ? "kilojoules" : "calories";
        if (col.values[key] === undefined) {
          col.values[key] = {
            value: tok.value,
            unit: tok.unit == "kj" ? "kJ" : "kcal",
            source: { value: tok.box, label: label ? this.lineBox(label.line) : undefined }
          };
          col.minY = Math.min(col.minY, tok.y);
        }
      });
    });

    result.forEach((col, i) => col.header = this.findHeader(lines, columns[i], col.minY, lineHeight));
    return result.filter((col) => Object.keys(col.values).length > 0);
  },

  // 1D clustering of token x positions into columns
  clusterColumns: function(tokens, lineHeight) {
    let xs = tokens.map((t) => t.x).sort((a, b) => a - b);
    let columns = [];
    xs.forEach((x) => {
      let col = columns[columns.length - 1];
      if (col !== undefined && x - col.max <= lineHeight * 1.2) {
        col.xs.push(x);
        col.max = x;
      } else {
        columns.push({ xs: [x], max: x });
      }
    });
    columns.forEach((c) => c.x = this.median(c.xs));
    // Ignore stray numbers: a column needs at least two values
    return columns.filter((c) => c.xs.length >= 2);
  },

  // Order-preserving alignment of label rows with value rows (dynamic programming), so
  // labels slightly above or below their values on curved or skewed packs still pair up
  alignRows: function(labels, rows, lineHeight) {
    let n = labels.length;
    let m = rows.length;
    let skip = 1.0;
    let cost = (i, j) => {
      let d = Math.abs(labels[i].y - rows[j].y) / lineHeight;
      return d > 1.6 ? Infinity : d * d;
    };
    let dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
    let from = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
    dp[0][0] = 0;
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= m; j++) {
        if (dp[i][j] == Infinity)
          continue;
        if (i < n && dp[i][j] + skip < dp[i + 1][j]) {
          dp[i + 1][j] = dp[i][j] + skip;
          from[i + 1][j] = [i, j, false];
        }
        if (j < m && dp[i][j] + skip < dp[i][j + 1]) {
          dp[i][j + 1] = dp[i][j] + skip;
          from[i][j + 1] = [i, j, false];
        }
        if (i < n && j < m) {
          let c = dp[i][j] + cost(i, j);
          if (c < dp[i + 1][j + 1]) {
            dp[i + 1][j + 1] = c;
            from[i + 1][j + 1] = [i, j, true];
          }
        }
      }
    }
    let pairs = [];
    let i = n;
    let j = m;
    while (i > 0 || j > 0) {
      let f = from[i][j];
      if (f[2])
        pairs.unshift({ label: labels[f[0]], row: rows[f[1]], rowIndex: f[1] });
      i = f[0];
      j = f[1];
    }
    return pairs;
  },

  // A value row with no label, between two matched rows whose nutrients have exactly one
  // nutrient between them in the usual table order, is assumed to be that nutrient
  inferMissingRows: function(pairs, rows, rowsByKey) {
    let order = this.canonicalOrder;
    let matched = new Map(pairs.map((p) => [p.rowIndex, p.label.key]));
    let idx = (key) => order.indexOf(key);

    rows.forEach((row, j) => {
      if (matched.has(j))
        return;
      let prev;
      let next;
      for (let k = j - 1; k >= 0 && prev === undefined; k--)
        prev = matched.get(k);
      for (let k = j + 1; k < rows.length && next === undefined; k++)
        next = matched.get(k);

      // Saturated fat always comes straight after fat, and sugars after carbohydrate, on
      // every layout: a row with no label just above them is that nutrient
      const parentOf = { "saturated-fat": "fat", "sugars": "carbohydrates" };
      let candidate;
      if (parentOf[matched.get(j + 1)] !== undefined)
        candidate = parentOf[matched.get(j + 1)];
      else if (prev !== undefined && next !== undefined && idx(prev) >= 0 && idx(next) - idx(prev) == 2)
        candidate = order[idx(prev) + 1];
      else if (prev == "proteins" && next === undefined && j == rows.length - 1)
        candidate = "salt";
      if (candidate !== undefined && rowsByKey[candidate] === undefined) {
        rowsByKey[candidate] = row;
        matched.set(j, candidate);
      }
    });
  },

  isHeaderLine: function(text) {
    let t = this.normalise(text.replace(/(\d),(\d)/g, "$1.$2"));
    if (/\b(per|pour|pro|por|je|par|para|avg|average|amount)\b/.test(t))
      return true;
    // Just a quantity: "100 g", "(20 g)", "/51g", "1009"
    if (/^\d+(\.\d+)? ?(g|ml|9)?$/.test(t.replace(/^\d+ (?=\d)/, "")) && /[(\/]|\b100 ?(g|ml)\b|\b1009\b/.test(text.toLowerCase()))
      return true;
    return /\b(serving|serve|portion|porcion|porzione|100 ?g|100 ?ml)\b/.test(t) && !/\d+(\.\d+)? ?(kj|kcal)\b/.test(t);
  },

  // Header text directly above the first value row and overlapping the column
  findHeader: function(lines, column, firstRowY, lineHeight) {
    let candidates = lines.filter((l) => l.y < firstRowY - lineHeight * 0.3 && l.y > firstRowY - lineHeight * 6 &&
      Math.abs(l.x - column.x) < Math.max(l.w / 2, lineHeight * 2));
    candidates.sort((a, b) => b.y - a.y);
    let text = candidates.map((l) => l.text).join(" ");
    let parsed = this.parseHeader(text);

    // Nothing recognisable just above: look further up for a "per 100 g/ml" over this column
    if (parsed === undefined) {
      let per100 = lines.filter((l) => l.y < firstRowY + lineHeight && l.y > firstRowY - lineHeight * 15 &&
        Math.abs(l.x - column.x) < Math.max(l.w / 2, lineHeight * 2) &&
        (this.parseHeader(l.text) || {}).basis == "100");
      per100.sort((a, b) => b.y - a.y);
      if (per100.length > 0)
        return { text: per100[0].text, parsed: this.parseHeader(per100[0].text) };
    }
    return { text: text, parsed: parsed };
  },

  // kcal = kJ / 4.184. A "/" is often read as "1", so try dropping a leading or trailing 1.
  fixEnergy: function(values) {
    let kj = values.kilojoules;
    let kcal = values.calories;
    if (kj === undefined || kcal === undefined)
      return;
    let expected = kj.value / 4.184;
    let ok = (v) => Math.abs(v - expected) <= Math.max(3, expected * 0.06);
    if (ok(kcal.value))
      return;
    let s = String(kcal.value);
    let fixes = [s.replace(/^1/, ""), s.replace(/1$/, "")].map(parseFloat).filter((v) => !isNaN(v) && ok(v));
    if (fixes.length > 0) {
      kcal.value = fixes[0];
      return;
    }
    s = String(kj.value);
    fixes = [s.replace(/^1/, ""), s.replace(/1$/, "")].map(parseFloat).filter((v) => !isNaN(v) && Math.abs(v / 4.184 - kcal.value) <= Math.max(3, kcal.value * 0.06));
    if (fixes.length > 0)
      kj.value = fixes[0];
  },

  // Decide each column's basis from its header, falling back to the serving size printed
  // elsewhere on the label and to the ratio between columns
  guessBases: function(columns, lines) {
    let servingSize = this.findServingSize(lines);

    columns.forEach((col) => {
      let p = col.header.parsed;
      col.basis = p ? p.basis : undefined;
      col.unit = p ? p.unit : undefined;
      col.amount = p && p.basis == "100" ? 100 : (p ? p.amount : undefined);
      if (col.basis == "serving" && col.amount === undefined && servingSize !== undefined) {
        col.amount = servingSize.amount;
        col.unit = servingSize.unit;
      }
    });

    // Check serving sizes read from headers against the per-100 column: a "/" before the
    // amount is often read as "1" ("/51g" -> "151g")
    let per100 = columns.find((c) => c.basis == "100");
    columns.forEach((col) => {
      if (per100 === undefined || col.basis != "serving" || col.amount === undefined)
        return;
      let ratios = [];
      for (let k in per100.values) {
        if (col.values[k] !== undefined && per100.values[k].value > 1)
          ratios.push(col.values[k].value / per100.values[k].value);
      }
      if (ratios.length < 3)
        return;
      let fromValues = this.median(ratios) * 100;
      let close = (a) => Math.abs(a - fromValues) <= fromValues * 0.08;
      if (close(col.amount))
        return;
      let stripped = parseFloat(String(col.amount).replace(/^1/, ""));
      if (!isNaN(stripped) && close(stripped))
        col.amount = stripped;
    });

    // Two columns, one known: if the other's values are a constant multiple, work out its size
    if (columns.length == 2) {
      let [a, b] = columns;
      let known = a.amount !== undefined ? a : (b.amount !== undefined ? b : undefined);
      let other = known === a ? b : a;
      if (known !== undefined && other.amount === undefined) {
        let ratios = [];
        for (let k in known.values) {
          if (other.values[k] !== undefined && known.values[k].value > 1)
            ratios.push(other.values[k].value / known.values[k].value);
        }
        let r = this.median(ratios);
        if (ratios.length >= 2 && r > 0) {
          let amount = Math.round(known.amount * r * 10) / 10;
          other.basis = Math.abs(amount - 100) < 1 ? "100" : "serving";
          other.amount = other.basis == "100" ? 100 : amount;
          other.unit = known.unit;
        }
      }
    }

    // Per serving and an unknown column with bigger values: the unknown one is per 100 g/ml
    // (Australian labels: "per serve" then "per 100 g")
    if (columns.length == 2) {
      let serving = columns.find((c) => c.basis == "serving");
      let other = columns.find((c) => c.basis === undefined);
      if (serving !== undefined && other !== undefined) {
        let ratios = [];
        for (let k in serving.values) {
          if (other.values[k] !== undefined && serving.values[k].value > 0)
            ratios.push(other.values[k].value / serving.values[k].value);
        }
        if (ratios.length >= 3 && this.median(ratios) > 1.2) {
          let mentionsMl = lines.some((l) => /100 ?ml\b/i.test(l.text));
          other.basis = "100";
          other.amount = 100;
          other.unit = serving.unit || (servingSize && servingSize.unit) || (mentionsMl ? "ml" : "g");
        }
      }
    }

    // Still nothing: with no headers, a lone column or the first of two is per 100 g on most labels
    columns.forEach((col, i) => {
      if (col.basis === undefined && servingSize !== undefined && columns.length == 1) {
        col.basis = "serving";
        col.amount = servingSize.amount;
        col.unit = servingSize.unit;
      }
    });
  },

  // "Serving size: 31g", either on one line or with the amount further along the same row
  findServingSize: function(lines) {
    let norm = (text) => this.normalise(text.replace(/(\d),(\d)/g, "$1.$2"));
    let label = /(serving size|serve size|portion size|taille de la portion|portionsgrosse|tamano de la porcion|porcion|porzione)/;
    let amount = /(\d+(?:\.\d+)?) ?(g|ml)\b/;
    for (let line of lines) {
      let t = norm(line.text);
      let i = t.search(label);
      if (i < 0)
        continue;
      let m = t.slice(i).match(amount);
      if (m === null) {
        let row = lines.filter((o) => o !== line && Math.abs(o.y - line.y) < line.h * 0.8 && o.x > line.x)
          .sort((a, b) => a.x - b.x);
        for (let o of row) {
          m = norm(o.text).match(amount);
          if (m !== null)
            break;
        }
      }
      if (m !== null)
        return { amount: parseFloat(m[1]), unit: m[2] };
    }
    return undefined;
  },

  // Converts a parsed value to the unit the app stores for that nutrient
  toAppUnit: function(key, entry, appUnit) {
    if (entry === undefined)
      return undefined;
    let from = entry.unit;
    if (from === undefined || from == appUnit || appUnit === undefined)
      return entry.value;
    if (this.unitFactors[from] !== undefined && this.unitFactors[appUnit] !== undefined)
      return entry.value * this.unitFactors[from] / this.unitFactors[appUnit];
    return entry.value;
  }
};
