// The flow engine's JavaScript side: expressions, conditions, the Code node, and the two transforms
// whose semantics are JavaScript's own (text, with JS regular expressions; dates, with Luxon).
//
// Loaded once per run into a QuickJS context, after `intl.js` and Luxon. The host talks to it
// through one function, `__cf_job(json)`, which takes a job as JSON text and resolves to a JSON
// text answer — `{"ok": …}` or `{"error": {…}}` — so nothing crosses the boundary but strings.
// What an expression can reach beyond the job (other nodes' output, the item a value came from) it
// asks the host for through `__host`, lazily: most expressions never look further than `$json`.
//
// **Expressions are n8n's.** A parameter value is an expression when it starts with `=`, and
// `{{ … }}` marks the JavaScript inside it. A value that is exactly one `{{ … }}` keeps the type of
// what it evaluates to — a number stays a number, an object an object — and anything else is text
// with the pieces stringified in. People arrive from n8n with these habits, and the names they
// reach for (`$json`, `$input.all()`, `$('Nodo').item`, `$now`) mean the same here.
(function (global) {
  "use strict";
  const host = global.__host;
  const { DateTime, Duration, Interval, Settings } = global.luxon;
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

  /** An error that knows which expression raised it, so the editor can point at the field. */
  class ExpressionError extends Error {
    constructor(message, expression) {
      super(message);
      this.expression = expression;
    }
  }

  // ---------------------------------------------------------------- templates

  const templates = new Map();

  /** Skips a quoted string starting at `i`, returning the index after its closing quote. */
  function skipString(text, i) {
    const quote = text[i];
    i += 1;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === quote) return i + 1;
      i += 1;
    }
    return i;
  }

  /**
   * Where the `}}` that closes a `{{` opened just before `from` is. Braces and strings inside the
   * expression are stepped over, so `{{ {a: {b: 1}} }}` and `{{ "}}" }}` close where a reader
   * expects. -1 when it never closes.
   */
  function findClose(text, from) {
    let depth = 0;
    let i = from;
    while (i < text.length) {
      const c = text[i];
      if (c === '"' || c === "'" || c === "`") {
        i = skipString(text, i);
        continue;
      }
      if (c === "{") depth += 1;
      else if (c === "}") {
        if (depth === 0 && text[i + 1] === "}") return i;
        if (depth > 0) depth -= 1;
      }
      i += 1;
    }
    return -1;
  }

  /** `text` cut into literal pieces and `{{ }}` expressions. An unclosed `{{` is literal text. */
  function parseTemplate(text) {
    let parts = templates.get(text);
    if (parts) return parts;
    parts = [];
    let i = 0;
    let start = 0;
    while (i < text.length - 1) {
      if (text[i] === "{" && text[i + 1] === "{") {
        const end = findClose(text, i + 2);
        if (end < 0) break;
        if (i > start) parts.push({ text: text.slice(start, i) });
        parts.push({ expr: text.slice(i + 2, end).trim() });
        i = end + 2;
        start = i;
      } else {
        i += 1;
      }
    }
    if (start < text.length) parts.push({ text: text.slice(start) });
    if (templates.size > 4000) templates.clear();
    templates.set(text, parts);
    return parts;
  }

  // ---------------------------------------------------------------- evaluation

  const SCOPE_NAMES = [
    "$json",
    "$input",
    "$",
    "$node",
    "$vars",
    "$now",
    "$today",
    "$execution",
    "$flow",
    "$workflow",
    "$runIndex",
    "$itemIndex",
    "$prevNode",
    "$if",
    "$ifEmpty",
    "$min",
    "$max",
    "$jmespath",
    "DateTime",
    "Duration",
    "Interval",
  ];

  const compiled = new Map();

  /**
   * The scope names a source can mention. Only those are bound: reading the rest would run their
   * getters for nothing — `$now` builds a DateTime, `$prevNode` asks the host — once per item, which
   * on ten thousand items is most of a node's time.
   */
  function namesIn(source, names) {
    return names.filter((name) => source.includes(name));
  }

  function compile(source) {
    let entry = compiled.get(source);
    if (entry) return entry;
    const names = namesIn(source || "", SCOPE_NAMES);
    let fn;
    try {
      fn = new Function(...names, `"use strict"; return (${source || "undefined"}\n);`);
    } catch (error) {
      throw new ExpressionError(error && error.message ? error.message : String(error), source);
    }
    if (compiled.size > 4000) compiled.clear();
    entry = { fn, names };
    compiled.set(source, entry);
    return entry;
  }

  function scopeValues(scope, names = SCOPE_NAMES) {
    return names.map((name) => scope[name]);
  }

  function evaluate(source, scope) {
    const { fn, names } = compile(source);
    try {
      return fn(...scopeValues(scope, names));
    } catch (error) {
      if (error instanceof ExpressionError) throw error;
      throw new ExpressionError(error && error.message ? error.message : String(error), source);
    }
  }

  /** How a value reads when it is spliced into text. */
  function stringify(value) {
    if (value === undefined || value === null) return "";
    if (typeof value === "string") return value;
    if (DateTime.isDateTime(value)) return value.toISO();
    if (Duration.isDuration(value)) return value.toISO();
    if (typeof value === "object") {
      try {
        return JSON.stringify(value);
      } catch (error) {
        return String(value);
      }
    }
    return String(value);
  }

  /** One template (the text after the `=`) against one scope. */
  function render(template, scope) {
    const parts = parseTemplate(template);
    if (parts.length === 1 && parts[0].expr !== undefined) return evaluate(parts[0].expr, scope);
    let out = "";
    for (const part of parts) out += part.expr !== undefined ? stringify(evaluate(part.expr, scope)) : part.text;
    return out;
  }

  function isExpression(value) {
    return typeof value === "string" && value.length > 0 && value[0] === "=";
  }

  /** A parameter tree with every expression in it evaluated. `skip` names top-level keys to leave alone. */
  function resolveValue(value, scope, skip) {
    if (isExpression(value)) return render(value.slice(1), scope);
    if (Array.isArray(value)) return value.map((entry) => resolveValue(entry, scope, null));
    if (value && typeof value === "object") {
      const out = {};
      for (const key of Object.keys(value)) out[key] = skip && skip.includes(key) ? value[key] : resolveValue(value[key], scope, null);
      return out;
    }
    return value;
  }

  // ---------------------------------------------------------------- the scope

  function parseHost(text) {
    return text === undefined || text === null || text === "" ? null : JSON.parse(text);
  }

  /** Everything one job's expressions can see, built once per job and specialised per item. */
  function makeJobContext(job) {
    const items = Array.isArray(job.items) ? job.items : [];
    const ctx = job.context || {};
    if (ctx.timezone) {
      try {
        Settings.defaultZone = ctx.timezone;
      } catch (error) {
        Settings.defaultZone = "system";
      }
    } else {
      Settings.defaultZone = "system";
    }
    const nodeCache = new Map();
    const nodeName = ctx.node || "";

    const wrap = (json) => ({ json: json === undefined ? {} : json });

    function nodeOutput(name) {
      if (nodeCache.has(name)) return nodeCache.get(name);
      const raw = parseHost(host.nodeOutput(String(name)));
      if (!raw) throw new Error(`No node is called "${name}"`);
      nodeCache.set(name, raw);
      return raw;
    }

    function pairedItem(name, index) {
      const raw = parseHost(host.pairedItem(String(name), nodeName, index));
      if (!raw) throw new Error(`No item from "${name}" leads to this one`);
      if (raw.error) throw new Error(raw.error);
      return wrap(raw.json);
    }

    function nodeProxy(name, index) {
      const output = (branch) => {
        const raw = nodeOutput(name);
        if (!raw.executed) throw new Error(`"${name}" has not run yet in this execution`);
        return (raw.outputs && raw.outputs[branch || 0]) || [];
      };
      return {
        get item() {
          return pairedItem(name, index);
        },
        itemMatching(i) {
          return pairedItem(name, Number(i));
        },
        first(branch) {
          const list = output(branch);
          return list.length ? wrap(list[0]) : undefined;
        },
        last(branch) {
          const list = output(branch);
          return list.length ? wrap(list[list.length - 1]) : undefined;
        },
        all(branch) {
          return output(branch).map(wrap);
        },
        get json() {
          return this.item.json;
        },
        get isExecuted() {
          return !!nodeOutput(name).executed;
        },
      };
    }

    const flow = Object.freeze(Object.assign({ id: "", name: "", active: false }, ctx.flow || {}));
    const execution = Object.freeze(Object.assign({ id: "", mode: "manual" }, ctx.execution || {}));
    const vars = Object.freeze(Object.assign({}, ctx.vars || {}));
    const helpers = {
      $if: (condition, whenTrue, whenFalse) => (condition ? whenTrue : whenFalse),
      $ifEmpty: (value, fallback) => (isEmpty(value) ? fallback : value),
      $min: (...values) => Math.min(...values.flat().map(Number)),
      $max: (...values) => Math.max(...values.flat().map(Number)),
      // `extensions.js`: JMESPath over any value — `$jmespath($json, "orders[?total > `100`].id")`.
      $jmespath: (data, expression) => global.__cf_jmespath(data, expression),
    };

    /** The scope for item `index` of the node's input. */
    function scopeFor(index) {
      const json = index < items.length ? items[index] : {};
      // `$`, `$node` and `$input` are made when read: an expression binds only the names it
      // mentions, and building them for every one of ten thousand items is most of the cost.
      const makeNode = () =>
        new Proxy(
          {},
          {
            get(_target, name) {
              if (typeof name !== "string") return undefined;
              const proxy = nodeProxy(name, index);
              return {
                get json() {
                  try {
                    return proxy.item.json;
                  } catch (error) {
                    const first = proxy.first();
                    return first ? first.json : {};
                  }
                },
              };
            },
          },
        );
      const makeInput = () => ({
        item: wrap(json),
        all: () => items.map(wrap),
        first: () => (items.length ? wrap(items[0]) : undefined),
        last: () => (items.length ? wrap(items[items.length - 1]) : undefined),
      });
      return Object.assign(
        {
          $json: json,
          get $input() {
            return makeInput();
          },
          get $() {
            return (name) => nodeProxy(name, index);
          },
          get $node() {
            return makeNode();
          },
          $vars: vars,
          get $now() {
            return DateTime.now();
          },
          get $today() {
            return DateTime.now().startOf("day");
          },
          $execution: execution,
          $flow: flow,
          $workflow: flow,
          $runIndex: ctx.runIndex || 0,
          $itemIndex: index,
          get $prevNode() {
            return parseHost(host.origin(nodeName, index)) || { name: "", outputIndex: 0, runIndex: 0 };
          },
          DateTime,
          Duration,
          Interval,
        },
        helpers,
      );
    }

    return { items, scopeFor, nodeName };
  }

  // ---------------------------------------------------------------- conditions

  function isEmpty(value) {
    if (value === undefined || value === null) return true;
    if (typeof value === "string") return value.length === 0;
    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "object" && !DateTime.isDateTime(value)) return Object.keys(value).length === 0;
    return false;
  }

  function asNumber(value) {
    if (typeof value === "number") return value;
    if (typeof value === "boolean") return value ? 1 : 0;
    if (typeof value === "string" && value.trim() !== "" && !isNaN(Number(value))) return Number(value);
    return null;
  }

  /** A date read the way a person typed it: an ISO string, a Luxon value, a JS Date, epoch millis. */
  function asDate(value) {
    if (DateTime.isDateTime(value)) return value.isValid ? value.toMillis() : null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
      const parsed = DateTime.fromISO(value.replace(" ", "T"));
      if (parsed.isValid) return parsed.toMillis();
      const sql = DateTime.fromSQL(value);
      return sql.isValid ? sql.toMillis() : null;
    }
    return null;
  }

  function asText(value, ignoreCase) {
    const text = stringify(value);
    return ignoreCase ? text.toLowerCase() : text;
  }

  function asBoolean(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    if (typeof value === "string") return ["true", "1", "yes", "sí", "si", "on"].includes(value.trim().toLowerCase());
    return !!value;
  }

  function toRegExp(pattern, ignoreCase) {
    const text = String(pattern === undefined || pattern === null ? "" : pattern);
    const literal = /^\/(.*)\/([dgimsuvy]*)$/s.exec(text);
    if (literal) return new RegExp(literal[1], literal[2].replace("g", "") + (ignoreCase && !literal[2].includes("i") ? "i" : ""));
    return new RegExp(text, ignoreCase ? "i" : "");
  }

  function lengthOf(value) {
    if (typeof value === "string" || Array.isArray(value)) return value.length;
    if (value && typeof value === "object") return Object.keys(value).length;
    return 0;
  }

  /** Numbers compare as numbers, dates as instants, everything else as text. */
  function compare(left, right, ignoreCase) {
    const a = asNumber(left);
    const b = asNumber(right);
    if (a !== null && b !== null) return a === b ? 0 : a < b ? -1 : 1;
    const da = asDate(left);
    const db = asDate(right);
    if (da !== null && db !== null) return da === db ? 0 : da < db ? -1 : 1;
    const ta = asText(left, ignoreCase);
    const tb = asText(right, ignoreCase);
    return ta === tb ? 0 : ta < tb ? -1 : 1;
  }

  function equal(left, right, ignoreCase) {
    if (left && right && typeof left === "object" && typeof right === "object" && !DateTime.isDateTime(left)) {
      return JSON.stringify(left) === JSON.stringify(right);
    }
    if ((left === null || left === undefined) && (right === null || right === undefined || right === "")) return true;
    return compare(left, right, ignoreCase) === 0;
  }

  function contains(left, right, ignoreCase) {
    if (Array.isArray(left)) return left.some((entry) => equal(entry, right, ignoreCase));
    return asText(left, ignoreCase).includes(asText(right, ignoreCase));
  }

  const OPERATORS = {
    exists: (l) => l !== undefined && l !== null,
    notExists: (l) => l === undefined || l === null,
    empty: (l) => isEmpty(l),
    notEmpty: (l) => !isEmpty(l),
    equals: (l, r, i) => equal(l, r, i),
    notEquals: (l, r, i) => !equal(l, r, i),
    contains: (l, r, i) => contains(l, r, i),
    notContains: (l, r, i) => !contains(l, r, i),
    startsWith: (l, r, i) => asText(l, i).startsWith(asText(r, i)),
    notStartsWith: (l, r, i) => !asText(l, i).startsWith(asText(r, i)),
    endsWith: (l, r, i) => asText(l, i).endsWith(asText(r, i)),
    notEndsWith: (l, r, i) => !asText(l, i).endsWith(asText(r, i)),
    regex: (l, r, i) => toRegExp(r, i).test(stringify(l)),
    notRegex: (l, r, i) => !toRegExp(r, i).test(stringify(l)),
    gt: (l, r, i) => compare(l, r, i) > 0,
    gte: (l, r, i) => compare(l, r, i) >= 0,
    lt: (l, r, i) => compare(l, r, i) < 0,
    lte: (l, r, i) => compare(l, r, i) <= 0,
    isTrue: (l) => asBoolean(l),
    isFalse: (l) => !asBoolean(l),
    lengthEquals: (l, r) => lengthOf(l) === Number(r),
    lengthGt: (l, r) => lengthOf(l) > Number(r),
    lengthLt: (l, r) => lengthOf(l) < Number(r),
    isNumber: (l) => asNumber(l) !== null,
    isDate: (l) => asDate(l) !== null,
    isArray: (l) => Array.isArray(l),
    isObject: (l) => !!l && typeof l === "object" && !Array.isArray(l),
  };

  /** One condition row against one item's scope. */
  function testCondition(condition, scope, ignoreCase) {
    const op = OPERATORS[condition.op] || OPERATORS.equals;
    const left = resolveValue(condition.left, scope, null);
    const right = resolveValue(condition.right, scope, null);
    return !!op(left, right, ignoreCase);
  }

  /** `{ combinator, conditions, ignoreCase }` against one item. No rows passes everything. */
  function testConditions(spec, scope) {
    const rows = (spec && Array.isArray(spec.conditions) ? spec.conditions : []).filter((row) => row && row.op);
    if (!rows.length) return true;
    const ignoreCase = !!(spec && spec.ignoreCase);
    if (spec && spec.combinator === "or") return rows.some((row) => testCondition(row, scope, ignoreCase));
    return rows.every((row) => testCondition(row, scope, ignoreCase));
  }

  // ---------------------------------------------------------------- text and dates

  function setPath(target, path, value) {
    const keys = String(path).split(".").filter(Boolean);
    if (!keys.length) return target;
    let cursor = target;
    for (let i = 0; i < keys.length - 1; i++) {
      if (!cursor[keys[i]] || typeof cursor[keys[i]] !== "object") cursor[keys[i]] = {};
      cursor = cursor[keys[i]];
    }
    cursor[keys[keys.length - 1]] = value;
    return target;
  }

  function words(text) {
    return String(text)
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);
  }

  function changeCase(text, style) {
    const value = String(text);
    switch (style) {
      case "upper":
        return value.toUpperCase();
      case "lower":
        return value.toLowerCase();
      case "title":
        return value.toLowerCase().replace(/(^|[\s\-_(])(\p{L})/gu, (_m, lead, letter) => lead + letter.toUpperCase());
      case "sentence":
        return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
      case "camel":
        return words(value)
          .map((word, index) => (index === 0 ? word.toLowerCase() : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
          .join("");
      case "snake":
        return words(value).map((word) => word.toLowerCase()).join("_");
      case "kebab":
      case "slug":
        return words(value).map((word) => word.toLowerCase()).join("-");
      default:
        return value;
    }
  }

  /** The Text node: one operation on one value of each item, written back into the item. */
  function textOperation(params, json) {
    const value = params.value;
    const ignoreCase = !!params.ignoreCase;
    switch (params.operation) {
      case "replace": {
        const text = stringify(value);
        if (params.useRegex) {
          const pattern = toRegExp(params.find, ignoreCase);
          const flags = pattern.flags.includes("g") || params.replaceAll === false ? pattern.flags : pattern.flags + "g";
          return text.replace(new RegExp(pattern.source, flags), params.replaceWith === undefined ? "" : String(params.replaceWith));
        }
        const find = stringify(params.find);
        if (!find) return text;
        const replacement = params.replaceWith === undefined ? "" : String(params.replaceWith);
        if (params.replaceAll === false) return text.replace(find, () => replacement);
        return text.split(find).join(replacement);
      }
      case "extract": {
        const pattern = toRegExp(params.pattern, ignoreCase);
        const text = stringify(value);
        const group = params.group === undefined || params.group === "" ? 0 : params.group;
        const pick = (match) => (match ? (typeof group === "number" || /^\d+$/.test(String(group)) ? match[Number(group)] : match.groups && match.groups[group]) : null);
        if (params.allMatches) {
          const flags = pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g";
          return Array.from(text.matchAll(new RegExp(pattern.source, flags)), pick).filter((entry) => entry !== undefined);
        }
        const found = pick(pattern.exec(text));
        return found === undefined ? null : found;
      }
      case "split": {
        const separator = params.separator === undefined || params.separator === "" ? "," : String(params.separator);
        let parts = stringify(value).split(params.useRegex ? toRegExp(separator, ignoreCase) : separator);
        if (params.trim !== false) parts = parts.map((part) => part.trim());
        if (params.dropEmpty !== false) parts = parts.filter((part) => part.length > 0);
        return parts;
      }
      case "join": {
        const list = Array.isArray(value) ? value : [value];
        return list.map(stringify).join(params.separator === undefined ? ", " : String(params.separator));
      }
      case "case":
        return changeCase(stringify(value), params.style || "lower");
      case "trim":
        return stringify(value).trim();
      case "truncate": {
        const text = stringify(value);
        const limit = Math.max(0, Number(params.length) || 0);
        if (text.length <= limit) return text;
        const ellipsis = params.ellipsis === undefined ? "…" : String(params.ellipsis);
        return text.slice(0, Math.max(0, limit - ellipsis.length)) + ellipsis;
      }
      case "length":
        return stringify(value).length;
      case "template":
        return stringify(params.template);
      default:
        throw new Error(`Unknown text operation "${params.operation}"`);
    }
  }

  /** A date read from whatever an item holds: ISO, SQL, epoch seconds or millis, or a custom format. */
  function readDate(value, format, zone) {
    const options = zone ? { zone } : {};
    if (DateTime.isDateTime(value)) return zone ? value.setZone(zone) : value;
    if (value instanceof Date) return DateTime.fromJSDate(value, options);
    if (value === undefined || value === null || value === "") return DateTime.now().setZone(zone || "system");
    if (format) return DateTime.fromFormat(String(value), String(format), options);
    if (typeof value === "number") return value > 1e11 ? DateTime.fromMillis(value, options) : DateTime.fromSeconds(value, options);
    const text = String(value).trim();
    if (/^\d+$/.test(text)) return text.length > 11 ? DateTime.fromMillis(Number(text), options) : DateTime.fromSeconds(Number(text), options);
    let parsed = DateTime.fromISO(text, options);
    if (!parsed.isValid) parsed = DateTime.fromSQL(text, options);
    if (!parsed.isValid) parsed = DateTime.fromRFC2822(text, options);
    if (!parsed.isValid) parsed = DateTime.fromHTTP(text, options);
    return parsed;
  }

  function writeDate(dt, format) {
    if (!dt.isValid) throw new Error(`Not a date: ${dt.invalidExplanation || dt.invalidReason || "invalid"}`);
    switch (format || "iso") {
      case "iso":
        return dt.toISO();
      case "date":
        return dt.toISODate();
      case "unixMillis":
        return dt.toMillis();
      case "unixSeconds":
        return Math.floor(dt.toSeconds());
      case "sql":
        return dt.toSQL({ includeOffset: false });
      case "http":
        return dt.toHTTP();
      case "relative":
        return dt.toRelative();
      default:
        return dt.toFormat(format);
    }
  }

  /** The Date node: one operation on one date of each item. */
  function dateOperation(params) {
    const zone = params.zone || undefined;
    const source = readDate(params.value, params.fromFormat, zone);
    const output = params.format === "custom" ? params.customFormat : params.format;
    switch (params.operation) {
      case "format":
        return writeDate(zone ? source.setZone(zone) : source, output);
      case "add":
      case "subtract": {
        const amount = Number(params.amount) || 0;
        const unit = params.unit || "days";
        const moved = params.operation === "add" ? source.plus({ [unit]: amount }) : source.minus({ [unit]: amount });
        return writeDate(moved, output);
      }
      case "startOf":
        return writeDate(source.startOf(params.unit ? params.unit.replace(/s$/, "") : "day"), output);
      case "endOf":
        return writeDate(source.endOf(params.unit ? params.unit.replace(/s$/, "") : "day"), output);
      case "diff": {
        const other = readDate(params.other, params.fromFormat, zone);
        if (!other.isValid) throw new Error("The second date is not a date");
        const unit = params.unit || "days";
        const value = source.diff(other, unit).as(unit);
        return params.round === false ? value : Math.round(value * 1000) / 1000;
      }
      case "setZone":
        return writeDate(source.setZone(params.toZone || "UTC"), output);
      case "extract": {
        if (!source.isValid) throw new Error("Not a date");
        const part = params.part || "year";
        return part === "weekdayName" ? source.toFormat("cccc") : part === "monthName" ? source.toFormat("LLLL") : source.get(part);
      }
      case "now":
        return writeDate(DateTime.now().setZone(zone || "system"), output);
      default:
        throw new Error(`Unknown date operation "${params.operation}"`);
    }
  }

  // ---------------------------------------------------------------- the Code node

  function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !DateTime.isDateTime(value);
  }

  /**
   * What a Code node returned, as items: `{ json }` wrappers are unwrapped (n8n's shape), plain
   * objects are items, anything else becomes `{ value }`. Each item says which input item it came
   * from — `pairedTo` in per-item mode, its position otherwise, or the `pairedItem` it declares.
   */
  function normaliseItems(result, pairedTo) {
    const list = Array.isArray(result) ? result : result === undefined || result === null ? [] : [result];
    const out = [];
    list.forEach((entry, index) => {
      if (entry === undefined || entry === null) return;
      let json;
      let declared = null;
      if (isPlainObject(entry) && isPlainObject(entry.json)) {
        json = entry.json;
        if (typeof entry.pairedItem === "number") declared = entry.pairedItem;
        else if (entry.pairedItem && typeof entry.pairedItem.item === "number") declared = entry.pairedItem.item;
      } else if (isPlainObject(entry)) {
        json = entry;
      } else {
        json = { value: entry };
      }
      out.push({ json, paired: declared !== null ? declared : pairedTo !== undefined ? pairedTo : index, declared: declared !== null });
    });
    return out;
  }

  function makeConsole(logs) {
    const line = (level) => (...args) => {
      if (logs.length >= 2000) return;
      logs.push({ level, text: args.map((arg) => (typeof arg === "string" ? arg : stringify(arg))).join(" ") });
    };
    return { log: line("log"), info: line("info"), warn: line("warn"), error: line("error"), debug: line("debug") };
  }

  const CODE_ALWAYS = ["items", "item", "console"];

  async function runCode(job, context) {
    const logs = [];
    const consoleObject = makeConsole(logs);
    let fn;
    // As with expressions: only the scope names the code mentions are bound.
    const names = namesIn(job.code || "", SCOPE_NAMES);
    try {
      fn = new AsyncFunction(...names, ...CODE_ALWAYS, `"use strict";\n${job.code || ""}\n`);
    } catch (error) {
      throw new ExpressionError(error && error.message ? error.message : String(error), null);
    }
    const all = context.items.map((json) => ({ json }));
    let out = [];
    if (job.mode === "each") {
      for (let index = 0; index < context.items.length; index++) {
        const scope = context.scopeFor(index);
        const args = scopeValues(scope, names).concat([all, { json: context.items[index] }, consoleObject]);
        const result = await fn(...args);
        out = out.concat(normaliseItems(result, index));
      }
    } else {
      const scope = context.scopeFor(0);
      const args = scopeValues(scope, names).concat([all, all.length ? all[0] : { json: {} }, consoleObject]);
      const result = await fn(...args);
      out = normaliseItems(result, undefined);
      // As many out as in: the n-th item came from the n-th. Otherwise nothing can be assumed
      // about an item that did not say where it came from.
      if (out.length !== context.items.length) for (const item of out) if (!item.declared) item.paired = null;
    }
    for (const item of out) delete item.declared;
    return { items: out, logs };
  }

  // ---------------------------------------------------------------- the entry point

  function describe(error) {
    const message = error && error.message ? error.message : String(error);
    const out = { message };
    if (error instanceof ExpressionError && error.expression) out.expression = error.expression;
    if (error && error.stack && !(error instanceof ExpressionError)) out.stack = String(error.stack).split("\n").slice(0, 6).join("\n");
    return out;
  }

  async function run(job) {
    const context = makeJobContext(job);
    const indices = Array.isArray(job.indices) ? job.indices : context.items.map((_item, index) => index);
    switch (job.kind) {
      case "resolve": {
        const skip = Array.isArray(job.skip) ? job.skip : null;
        // At least one evaluation even with no input, so a parameter can be read on an empty run.
        const at = indices.length ? indices : [0];
        return at.map((index) => resolveValue(job.params, context.scopeFor(index), skip));
      }
      case "conditions":
        return indices.map((index) => testConditions(job.spec, context.scopeFor(index)));
      case "switch":
        return indices.map((index) => {
          const scope = context.scopeFor(index);
          const spec = job.spec || {};
          if (spec.mode === "expression") {
            const value = Number(resolveValue(spec.output, scope, null));
            return Number.isInteger(value) && value >= 0 ? [value] : [];
          }
          const hits = [];
          for (const rule of Array.isArray(spec.rules) ? spec.rules : []) {
            const output = Number(rule.output) || 0;
            if (hits.includes(output)) continue;
            if (testCondition(rule, scope, !!spec.ignoreCase)) {
              hits.push(output);
              if (!spec.allMatching) break;
            }
          }
          return hits;
        });
      case "text":
        return indices.map((index) => {
          const scope = context.scopeFor(index);
          const params = resolveValue(job.params, scope, null);
          const json = JSON.parse(JSON.stringify(context.items[index] || {}));
          return setPath(json, params.target || "text", textOperation(params, json));
        });
      case "date":
        return indices.map((index) => {
          const scope = context.scopeFor(index);
          const params = resolveValue(job.params, scope, null);
          const json = JSON.parse(JSON.stringify(context.items[index] || {}));
          return setPath(json, params.target || "date", dateOperation(params));
        });
      case "code":
        return runCode(job, context);
      case "eval": {
        const index = typeof job.index === "number" ? job.index : 0;
        const value = isExpression(job.expression) ? render(job.expression.slice(1), context.scopeFor(index)) : job.expression;
        return { value: value === undefined ? null : value, type: value === null ? "null" : Array.isArray(value) ? "array" : DateTime.isDateTime(value) ? "date" : typeof value };
      }
      default:
        throw new Error(`Unknown job "${job.kind}"`);
    }
  }

  /** Serialises an answer, turning what JSON cannot hold into what it can. */
  function encode(value) {
    return JSON.stringify(value, (_key, entry) => {
      if (entry === undefined) return null;
      if (typeof entry === "bigint") return entry.toString();
      if (typeof entry === "number" && !isFinite(entry)) return null;
      return entry;
    });
  }

  global.__cf_job = async function (text) {
    try {
      const job = JSON.parse(text);
      const ok = await run(job);
      return encode({ ok });
    } catch (error) {
      return encode({ error: describe(error) });
    }
  };
})(globalThis);
