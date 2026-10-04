// The slice of `Intl` that Luxon reaches for, for an engine that has none.
//
// QuickJS ships without ICU, so `Intl` is simply absent — and Luxon, which is what flow expressions
// use for dates (`$now.plus({ days: 1 }).toFormat("yyyy-MM-dd")`), calls it for three things: the
// wall-clock fields of an instant in a named time zone, the default locale and zone, and month and
// weekday names outside English. This file answers exactly those, in English and Spanish (the app's
// two languages), with the time-zone arithmetic done by the host from the tz database it was built
// with (`__host.tzParts`). Anything it does not know degrades to English or to numbers rather than
// throwing, because an expression that formats a date must not fail on the formatting.
//
// It also points `toLocaleString` and friends at the same code, so `(1234.5).toLocaleString("es")`
// and `new Date().toLocaleDateString()` inside an expression mean what they mean in a browser.
(function (global) {
  "use strict";
  if (typeof global.Intl !== "undefined") return;
  const host = global.__host;

  const NAMES = {
    en: {
      months: {
        long: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
        short: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
        narrow: ["J", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"],
      },
      // Monday first, as `parts.weekday` counts (1 = Monday … 7 = Sunday).
      weekdays: {
        long: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
        short: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
        narrow: ["M", "T", "W", "T", "F", "S", "S"],
      },
      dayPeriods: ["AM", "PM"],
      eras: { long: ["Before Christ", "Anno Domini"], short: ["BC", "AD"], narrow: ["B", "A"] },
      list: { conjunction: "and", disjunction: "or" },
      units: {
        year: ["year", "years", "yr"],
        quarter: ["quarter", "quarters", "qtr"],
        month: ["month", "months", "mth"],
        week: ["week", "weeks", "wk"],
        day: ["day", "days", "day"],
        hour: ["hour", "hours", "hr"],
        minute: ["minute", "minutes", "min"],
        second: ["second", "seconds", "sec"],
        millisecond: ["millisecond", "milliseconds", "ms"],
      },
      decimal: ".",
      group: ",",
      minGrouping: 1,
      hourCycle: "h12",
    },
    es: {
      months: {
        long: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
        short: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"],
        narrow: ["E", "F", "M", "A", "M", "J", "J", "A", "S", "O", "N", "D"],
      },
      weekdays: {
        long: ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"],
        short: ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"],
        narrow: ["L", "M", "X", "J", "V", "S", "D"],
      },
      dayPeriods: ["a. m.", "p. m."],
      eras: { long: ["antes de Cristo", "después de Cristo"], short: ["a. C.", "d. C."], narrow: ["a. C.", "d. C."] },
      list: { conjunction: "y", disjunction: "o" },
      units: {
        year: ["año", "años", "a"],
        quarter: ["trimestre", "trimestres", "trim."],
        month: ["mes", "meses", "m."],
        week: ["semana", "semanas", "sem."],
        day: ["día", "días", "d"],
        hour: ["hora", "horas", "h"],
        minute: ["minuto", "minutos", "min"],
        second: ["segundo", "segundos", "s"],
        millisecond: ["milisegundo", "milisegundos", "ms"],
      },
      decimal: ",",
      group: ".",
      // CLDR's minimumGroupingDigits for Spanish: 1234 stays "1234", 12345 becomes "12.345".
      minGrouping: 2,
      hourCycle: "h23",
    },
  };

  const DEFAULT_LOCALE = (host && host.locale && host.locale()) || "en-US";

  /** The language a tag asks for, among the two this file can speak; English otherwise. */
  function languageOf(locale) {
    const tag = String(Array.isArray(locale) ? locale[0] || DEFAULT_LOCALE : locale || DEFAULT_LOCALE).toLowerCase();
    return tag === "es" || tag.startsWith("es-") ? "es" : "en";
  }

  function resolveLocale(locale) {
    const tag = Array.isArray(locale) ? locale[0] : locale;
    if (typeof tag === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return tag;
    return DEFAULT_LOCALE;
  }

  const SYSTEM_ZONE = (host && host.systemZone && host.systemZone()) || "UTC";

  function validZone(zone) {
    if (zone === "UTC" || zone === "Etc/UTC" || zone === "GMT") return true;
    return !!(host && host.tzValid && host.tzValid(zone));
  }

  /**
   * The wall-clock fields of `ms` in `zone`. The host owns the tz database and answers with JSON
   * text, `[year, month, day, hour, minute, second, weekday (1 = Monday), offset in minutes,
   * abbreviation]`; without a zone the C library's local time is the answer, which is what `Date`
   * itself uses.
   */
  function wallClock(ms, zone) {
    if (zone && zone !== "local") {
      const parts = JSON.parse(host.tzParts(zone, ms));
      return {
        year: parts[0],
        month: parts[1],
        day: parts[2],
        hour: parts[3],
        minute: parts[4],
        second: parts[5],
        weekday: parts[6],
        offset: parts[7],
        abbreviation: parts[8],
        millisecond: ((ms % 1000) + 1000) % 1000,
      };
    }
    const d = new Date(ms);
    const day = d.getDay();
    return {
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      day: d.getDate(),
      hour: d.getHours(),
      minute: d.getMinutes(),
      second: d.getSeconds(),
      weekday: day === 0 ? 7 : day,
      offset: -d.getTimezoneOffset(),
      abbreviation: "",
      millisecond: d.getMilliseconds(),
    };
  }

  function pad(value, width) {
    const text = String(Math.abs(value));
    const sign = value < 0 ? "-" : "";
    return sign + (text.length >= width ? text : "0".repeat(width - text.length) + text);
  }

  function gmtOffset(minutes, long) {
    if (minutes === 0) return "GMT";
    const sign = minutes < 0 ? "-" : "+";
    const abs = Math.abs(minutes);
    const hours = Math.floor(abs / 60);
    const rest = abs % 60;
    if (long) return `GMT${sign}${pad(hours, 2)}:${pad(rest, 2)}`;
    return rest ? `GMT${sign}${hours}:${pad(rest, 2)}` : `GMT${sign}${hours}`;
  }

  const DATE_FIELDS = ["weekday", "era", "year", "month", "day"];
  const TIME_FIELDS = ["dayPeriod", "hour", "minute", "second", "fractionalSecondDigits"];

  class DateTimeFormat {
    constructor(locale, options) {
      const opts = Object.assign({}, options || {});
      this._locale = resolveLocale(locale);
      this._lang = languageOf(this._locale);
      if (opts.timeZone !== undefined) {
        const zone = String(opts.timeZone);
        if (!validZone(zone)) throw new RangeError(`Invalid time zone specified: ${zone}`);
        opts.timeZone = zone === "Etc/UTC" || zone === "GMT" ? "UTC" : zone;
      }
      if (opts.dateStyle || opts.timeStyle) {
        const date = { full: { weekday: "long", year: "numeric", month: "long", day: "numeric" },
          long: { year: "numeric", month: "long", day: "numeric" },
          medium: { year: "numeric", month: "short", day: "numeric" },
          short: { year: "2-digit", month: "numeric", day: "numeric" } }[opts.dateStyle];
        const time = { full: { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "long" },
          long: { hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" },
          medium: { hour: "numeric", minute: "2-digit", second: "2-digit" },
          short: { hour: "numeric", minute: "2-digit" } }[opts.timeStyle];
        Object.assign(opts, date || {}, time || {});
      }
      const anyField = DATE_FIELDS.concat(TIME_FIELDS, ["timeZoneName"]).some((field) => opts[field] !== undefined);
      if (!anyField) Object.assign(opts, { year: "numeric", month: "numeric", day: "numeric" });
      let hourCycle = opts.hourCycle || NAMES[this._lang].hourCycle;
      if (opts.hour12 === true) hourCycle = "h12";
      if (opts.hour12 === false) hourCycle = "h23";
      this._hourCycle = hourCycle;
      this._opts = opts;
    }

    static supportedLocalesOf(locales) {
      return (Array.isArray(locales) ? locales : [locales]).filter((locale) => typeof locale === "string");
    }

    resolvedOptions() {
      const out = {
        locale: this._locale,
        calendar: "gregory",
        numberingSystem: "latn",
        timeZone: this._opts.timeZone || SYSTEM_ZONE,
      };
      for (const field of DATE_FIELDS.concat(TIME_FIELDS, ["timeZoneName"])) {
        if (this._opts[field] !== undefined) out[field] = this._opts[field];
      }
      if (this._opts.hour !== undefined) {
        out.hourCycle = this._hourCycle;
        out.hour12 = this._hourCycle === "h12" || this._hourCycle === "h11";
      }
      return out;
    }

    format(date) {
      return this.formatToParts(date)
        .map((part) => part.value)
        .join("");
    }

    formatToParts(date) {
      const ms = date === undefined ? Date.now() : Number(date instanceof Date ? date.getTime() : date);
      if (!isFinite(ms)) throw new RangeError("Invalid time value");
      const o = this._opts;
      const names = NAMES[this._lang];
      const w = wallClock(ms, o.timeZone);
      const parts = [];
      const push = (type, value) => parts.push({ type, value: String(value) });
      const lit = (value) => parts.push({ type: "literal", value });

      const textualMonth = o.month === "long" || o.month === "short" || o.month === "narrow";
      const yearValue = () => {
        const year = w.year <= 0 && o.era ? 1 - w.year : w.year;
        return o.year === "2-digit" ? pad(Math.abs(year) % 100, 2) : String(year);
      };
      const monthValue = () => (textualMonth ? names.months[o.month][w.month - 1] : o.month === "2-digit" ? pad(w.month, 2) : String(w.month));
      const dayValue = () => (o.day === "2-digit" ? pad(w.day, 2) : String(w.day));

      // The date, in the order each language writes it.
      const hasDate = o.year !== undefined || o.month !== undefined || o.day !== undefined;
      if (o.weekday !== undefined) {
        push("weekday", names.weekdays[o.weekday][w.weekday - 1] || names.weekdays.long[w.weekday - 1]);
        if (hasDate) lit(", ");
      }
      if (hasDate) {
        if (this._lang === "es") {
          if (textualMonth) {
            const joiner = o.month === "long" ? " de " : " ";
            if (o.day !== undefined) {
              push("day", dayValue());
              if (o.month !== undefined) lit(joiner);
            }
            if (o.month !== undefined) push("month", monthValue());
            if (o.year !== undefined) {
              lit(joiner);
              push("year", yearValue());
            }
          } else {
            const fields = [];
            if (o.day !== undefined) fields.push(["day", dayValue()]);
            if (o.month !== undefined) fields.push(["month", monthValue()]);
            if (o.year !== undefined) fields.push(["year", yearValue()]);
            fields.forEach(([type, value], index) => {
              if (index > 0) lit("/");
              push(type, value);
            });
          }
        } else if (textualMonth) {
          if (o.month !== undefined) push("month", monthValue());
          if (o.day !== undefined) {
            if (o.month !== undefined) lit(" ");
            push("day", dayValue());
          }
          if (o.year !== undefined) {
            lit(o.day !== undefined ? ", " : " ");
            push("year", yearValue());
          }
        } else {
          const fields = [];
          if (o.month !== undefined) fields.push(["month", monthValue()]);
          if (o.day !== undefined) fields.push(["day", dayValue()]);
          if (o.year !== undefined) fields.push(["year", yearValue()]);
          fields.forEach(([type, value], index) => {
            if (index > 0) lit("/");
            push(type, value);
          });
        }
      }
      if (o.era !== undefined) {
        if (parts.length) lit(" ");
        push("era", names.eras[o.era === "long" ? "long" : o.era === "narrow" ? "narrow" : "short"][w.year > 0 ? 1 : 0]);
      }

      // The time.
      const hasTime = o.hour !== undefined || o.minute !== undefined || o.second !== undefined;
      if (hasTime) {
        if (parts.length) lit(", ");
        const twelve = this._hourCycle === "h12" || this._hourCycle === "h11";
        const fields = [];
        if (o.hour !== undefined) {
          let hour = w.hour;
          if (this._hourCycle === "h12") hour = hour % 12 === 0 ? 12 : hour % 12;
          else if (this._hourCycle === "h11") hour = hour % 12;
          else if (this._hourCycle === "h24") hour = hour === 0 ? 24 : hour;
          fields.push(["hour", o.hour === "2-digit" ? pad(hour, 2) : String(hour)]);
        }
        if (o.minute !== undefined) fields.push(["minute", o.minute === "2-digit" || o.hour !== undefined ? pad(w.minute, 2) : String(w.minute)]);
        if (o.second !== undefined) fields.push(["second", o.second === "2-digit" || o.minute !== undefined ? pad(w.second, 2) : String(w.second)]);
        fields.forEach(([type, value], index) => {
          if (index > 0) lit(":");
          push(type, value);
        });
        if (o.fractionalSecondDigits) {
          lit(this._lang === "es" ? "," : ".");
          push("fractionalSecond", pad(w.millisecond, 3).slice(0, o.fractionalSecondDigits));
        }
        if (o.hour !== undefined && twelve) {
          lit(" ");
          push("dayPeriod", names.dayPeriods[w.hour < 12 ? 0 : 1]);
        }
      } else if (o.dayPeriod !== undefined) {
        if (parts.length) lit(" ");
        push("dayPeriod", names.dayPeriods[w.hour < 12 ? 0 : 1]);
      }

      if (o.timeZoneName !== undefined) {
        if (parts.length) lit(" ");
        const zone = o.timeZone || SYSTEM_ZONE;
        let value;
        if (o.timeZoneName === "long" || o.timeZoneName === "longGeneric") value = zone === "UTC" ? "Coordinated Universal Time" : zone;
        else if (o.timeZoneName === "longOffset") value = gmtOffset(w.offset, true);
        else if (o.timeZoneName === "shortOffset") value = gmtOffset(w.offset, false);
        else if (zone === "UTC") value = "UTC";
        else value = /^[A-Za-z]{2,5}$/.test(w.abbreviation || "") ? w.abbreviation : gmtOffset(w.offset, false);
        push("timeZoneName", value);
      }
      return parts;
    }
  }

  function groupDigits(integer, lang) {
    const names = NAMES[lang];
    if (integer.length < 4 || integer.length < 4 + (names.minGrouping - 1)) return integer;
    let out = "";
    for (let i = 0; i < integer.length; i++) {
      if (i > 0 && (integer.length - i) % 3 === 0) out += names.group;
      out += integer[i];
    }
    return out;
  }

  const CURRENCY_SYMBOLS = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CLP: "$", MXN: "$", ARS: "$", COP: "$", PEN: "S/", BRL: "R$" };

  class NumberFormat {
    constructor(locale, options) {
      this._locale = resolveLocale(locale);
      this._lang = languageOf(this._locale);
      this._opts = Object.assign({ style: "decimal", useGrouping: true }, options || {});
    }

    static supportedLocalesOf(locales) {
      return (Array.isArray(locales) ? locales : [locales]).filter((locale) => typeof locale === "string");
    }

    resolvedOptions() {
      return Object.assign({ locale: this._locale, numberingSystem: "latn" }, this._opts);
    }

    format(value) {
      const o = this._opts;
      const names = NAMES[this._lang];
      let number = Number(value);
      if (o.style === "percent") number *= 100;
      if (!isFinite(number)) return isNaN(number) ? "NaN" : number < 0 ? "-∞" : "∞";
      const currency = o.style === "currency";
      const minFraction = o.minimumFractionDigits !== undefined ? o.minimumFractionDigits : currency && o.currency !== "CLP" && o.currency !== "JPY" ? 2 : 0;
      const maxFraction = Math.max(minFraction, o.maximumFractionDigits !== undefined ? o.maximumFractionDigits : currency ? minFraction : o.style === "percent" ? 0 : 3);
      const negative = number < 0 || Object.is(number, -0);
      let [integer, fraction = ""] = Math.abs(number).toFixed(maxFraction).split(".");
      while (fraction.length > minFraction && fraction.endsWith("0")) fraction = fraction.slice(0, -1);
      if (o.minimumIntegerDigits && integer.length < o.minimumIntegerDigits) integer = "0".repeat(o.minimumIntegerDigits - integer.length) + integer;
      if (o.useGrouping !== false) integer = groupDigits(integer, this._lang);
      let text = fraction ? integer + names.decimal + fraction : integer;
      if (o.style === "percent") text += this._lang === "es" ? " %" : "%";
      else if (o.style === "unit" && o.unit) {
        const unit = names.units[String(o.unit).replace(/s$/, "")];
        const label = unit ? (o.unitDisplay === "short" || o.unitDisplay === "narrow" ? unit[2] : Math.abs(number) === 1 ? unit[0] : unit[1]) : o.unit;
        text += o.unitDisplay === "narrow" && unit ? label : ` ${label}`;
      } else if (currency) {
        const code = String(o.currency || "USD").toUpperCase();
        const symbol = o.currencyDisplay === "code" ? code : CURRENCY_SYMBOLS[code] || code;
        text = this._lang === "es" ? `${text} ${symbol}` : symbol.length > 1 && /^[A-Z]+$/.test(symbol) ? `${symbol} ${text}` : symbol + text;
      }
      return negative && Number(value) !== 0 ? `-${text}` : text;
    }

    formatToParts(value) {
      return [{ type: "literal", value: this.format(value) }];
    }
  }

  class ListFormat {
    constructor(locale, options) {
      this._lang = languageOf(resolveLocale(locale));
      this._opts = Object.assign({ type: "conjunction", style: "long" }, options || {});
    }

    format(list) {
      const items = Array.from(list || [], String);
      if (this._opts.type === "unit") return items.join(this._opts.style === "narrow" ? " " : ", ");
      const word = NAMES[this._lang].list[this._opts.type === "disjunction" ? "disjunction" : "conjunction"];
      if (items.length <= 1) return items.join("");
      if (items.length === 2) return `${items[0]} ${word} ${items[1]}`;
      const head = items.slice(0, -1).join(", ");
      // The serial comma is English's; Spanish has none.
      return this._lang === "en" ? `${head}, ${word} ${items[items.length - 1]}` : `${head} ${word} ${items[items.length - 1]}`;
    }
  }

  global.Intl = { DateTimeFormat, NumberFormat, ListFormat };

  Number.prototype.toLocaleString = function (locale, options) {
    return new NumberFormat(locale, options).format(this);
  };
  Date.prototype.toLocaleString = function (locale, options) {
    const opts = Object.assign({}, options || {});
    if (![...DATE_FIELDS, ...TIME_FIELDS, "dateStyle", "timeStyle"].some((field) => opts[field] !== undefined)) {
      Object.assign(opts, { year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" });
    }
    return new DateTimeFormat(locale, opts).format(this);
  };
  Date.prototype.toLocaleDateString = function (locale, options) {
    return new DateTimeFormat(locale, options).format(this);
  };
  Date.prototype.toLocaleTimeString = function (locale, options) {
    const opts = Object.assign({}, options || {});
    if (![...TIME_FIELDS, "timeStyle"].some((field) => opts[field] !== undefined)) {
      Object.assign(opts, { hour: "numeric", minute: "2-digit", second: "2-digit" });
    }
    return new DateTimeFormat(locale, opts).format(this);
  };
})(globalThis);
