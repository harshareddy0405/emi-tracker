import { randomUUID } from "node:crypto";
import { ApiError } from "./http.js";

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CORE_LOAN_FIELDS = new Set([
  "id", "name", "lender", "category", "repaymentType", "interestOnly", "original", "originalPrincipal",
  "outstanding", "outstandingPrincipal", "emi", "monthlyPayment", "rate", "annualInterestRate", "fixedInterest",
  "dueDay", "start", "end", "baseMonth", "paidThrough", "autoPay", "active", "source", "note",
  "sourceDocumentId", "imported", "details", "record", "createdAt", "updatedAt"
]);

function text(value, field, { required = true, max = 255 } = {}) {
  if (value === null || value === undefined || value === "") {
    if (!required) return null;
    throw new ApiError(422, `${field} is required.`, "validation_error");
  }
  if (typeof value !== "string") throw new ApiError(422, `${field} must be text.`, "validation_error");
  const cleaned = value.trim();
  if ((required && !cleaned) || cleaned.length > max || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(cleaned)) {
    throw new ApiError(422, `${field} is invalid.`, "validation_error");
  }
  return cleaned || null;
}

function number(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER, required = true, decimals = 2 } = {}) {
  if ((value === null || value === undefined || value === "") && !required) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new ApiError(422, `${field} is invalid.`, "validation_error");
  }
  if (decimals === 0 && !Number.isInteger(parsed)) {
    throw new ApiError(422, `${field} must be a whole number.`, "validation_error");
  }
  const factor = 10 ** decimals;
  return Math.round((parsed + Number.EPSILON) * factor) / factor;
}

function boolean(value, field, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new ApiError(422, `${field} must be true or false.`, "validation_error");
  return value;
}

function safeJson(value, field, { maxBytes = 128 * 1024 } = {}) {
  if (value === undefined || value === null) return {};
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new ApiError(422, `${field} must be valid JSON.`, "validation_error");
  }
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw new ApiError(422, `${field} is too large.`, "validation_error");
  }
  const parsed = JSON.parse(encoded);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(422, `${field} must be an object.`, "validation_error");
  }
  return parsed;
}

export function normalizeMonth(value, field = "month", { required = true } = {}) {
  if ((value === null || value === undefined || value === "") && !required) return null;
  const match = typeof value === "string" ? MONTH_PATTERN.exec(value) : null;
  const year = match ? Number(match[1]) : 0;
  if (!match || year < 1900 || year > 2200) {
    throw new ApiError(422, `${field} must use YYYY-MM format.`, "validation_error");
  }
  return value;
}

export function monthToDate(month) {
  return `${month}-01`;
}

export function dateToMonth(value) {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 7);
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}`;
  }
  throw new Error("Invalid database month value.");
}

export function normalizeLoan(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(422, "loan must be an object.", "validation_error");
  }

  const id = input.id === undefined || input.id === null || input.id === ""
    ? `custom-${randomUUID()}`
    : text(input.id, "loan.id", { max: 128 });
  if (!LOAN_ID_PATTERN.test(id)) throw new ApiError(422, "loan.id is invalid.", "validation_error");

  const start = normalizeMonth(input.start, "loan.start");
  const end = normalizeMonth(input.end, "loan.end");
  if (end < start) throw new ApiError(422, "loan.end must not be before loan.start.", "validation_error");

  const repaymentType = input.repaymentType || (input.interestOnly ? "interest_only" : "amortizing");
  if (!["amortizing", "interest_only"].includes(repaymentType)) {
    throw new ApiError(422, "loan.repaymentType is invalid.", "validation_error");
  }

  const emi = number(input.emi ?? input.monthlyPayment, "loan.emi", { min: 0, max: 999999999999.99 });
  const interestOnly = repaymentType === "interest_only";
  const sourceDocumentId = input.sourceDocumentId === undefined || input.sourceDocumentId === null || input.sourceDocumentId === ""
    ? null
    : text(input.sourceDocumentId, "loan.sourceDocumentId", { max: 36 });
  if (sourceDocumentId && !UUID_PATTERN.test(sourceDocumentId)) {
    throw new ApiError(422, "loan.sourceDocumentId is invalid.", "validation_error");
  }

  const extraFields = {};
  for (const [key, value] of Object.entries(input)) {
    if (!CORE_LOAN_FIELDS.has(key) && !["__proto__", "prototype", "constructor"].includes(key)) extraFields[key] = value;
  }
  const providedDetails = safeJson(input.details, "loan.details");
  const details = safeJson({ ...providedDetails, ...extraFields }, "loan.details");

  return {
    id,
    name: text(input.name, "loan.name", { max: 160 }),
    lender: text(input.lender, "loan.lender", { max: 160 }),
    category: text(input.category, "loan.category", { max: 80 }),
    repaymentType,
    interestOnly,
    original: number(input.original ?? input.originalPrincipal ?? input.outstanding, "loan.original", { min: 0, max: 999999999999.99 }),
    outstanding: number(input.outstanding ?? input.outstandingPrincipal, "loan.outstanding", { min: 0, max: 999999999999.99 }),
    emi,
    rate: number(input.rate ?? input.annualInterestRate ?? 0, "loan.rate", { min: 0, max: 100, decimals: 4 }),
    fixedInterest: input.fixedInterest === undefined || input.fixedInterest === null || input.fixedInterest === ""
      ? (interestOnly ? emi : null)
      : number(input.fixedInterest, "loan.fixedInterest", { min: 0, max: 999999999999.99 }),
    dueDay: number(input.dueDay, "loan.dueDay", { min: 1, max: 31, decimals: 0 }),
    start,
    end,
    baseMonth: normalizeMonth(input.baseMonth || start, "loan.baseMonth"),
    paidThrough: normalizeMonth(input.paidThrough, "loan.paidThrough", { required: false }),
    autoPay: boolean(input.autoPay, "loan.autoPay"),
    active: boolean(input.active, "loan.active", true),
    imported: boolean(input.imported, "loan.imported", false),
    source: text(input.source, "loan.source", { required: false, max: 255 }),
    note: text(input.note, "loan.note", { required: false, max: 5000 }),
    sourceDocumentId,
    details
  };
}

export function normalizeRecord(input) {
  if (input === undefined || input === null) return null;
  const record = safeJson(input, "record", { maxBytes: 256 * 1024 });
  if (!Array.isArray(record.sourceFiles) || !Array.isArray(record.sections)) {
    throw new ApiError(422, "record must include sourceFiles and sections arrays.", "validation_error");
  }
  if (record.sourceFiles.length > 100 || record.sections.length > 100) {
    throw new ApiError(422, "record contains too many entries.", "validation_error");
  }
  for (const section of record.sections) {
    if (!section || typeof section !== "object" || typeof section.title !== "string" || !Array.isArray(section.fields)) {
      throw new ApiError(422, "record.sections is invalid.", "validation_error");
    }
    if (section.fields.length > 500 || section.fields.some((field) => !Array.isArray(field) || field.length !== 2)) {
      throw new ApiError(422, "record section fields are invalid.", "validation_error");
    }
  }
  return record;
}

export function normalizeLoanId(value) {
  const id = text(value, "loanId", { max: 128 });
  if (!LOAN_ID_PATTERN.test(id)) throw new ApiError(422, "loanId is invalid.", "validation_error");
  return id;
}

export function normalizeSettings(input, current = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(422, "settings must be an object.", "validation_error");
  }
  const currency = input.currency === undefined ? (current.currency || "INR") : text(input.currency, "settings.currency", { max: 3 }).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new ApiError(422, "settings.currency is invalid.", "validation_error");
  const theme = input.dark === undefined
    ? (input.theme ?? current.theme ?? "light")
    : (input.dark ? "dark" : "light");
  if (!["light", "dark", "system"].includes(theme)) throw new ApiError(422, "settings.theme is invalid.", "validation_error");
  return {
    monthlyIncome: input.monthlyIncome === undefined
      ? Number(current.monthlyIncome ?? 0)
      : number(input.monthlyIncome, "settings.monthlyIncome", { min: 0, max: 999999999999.99 }),
    reportedMonthlyOutflow: input.reportedMonthlyOutflow === undefined
      ? Number(current.reportedMonthlyOutflow ?? 0)
      : number(input.reportedMonthlyOutflow, "settings.reportedMonthlyOutflow", { min: 0, max: 999999999999.99 }),
    currency,
    timezone: input.timezone === undefined
      ? (current.timezone || "Asia/Kolkata")
      : text(input.timezone, "settings.timezone", { max: 80 }),
    theme,
    monthlyRoll: input.monthlyRoll === undefined
      ? Boolean(current.monthlyRoll ?? true)
      : boolean(input.monthlyRoll, "settings.monthlyRoll"),
    reminders: input.reminders === undefined
      ? Boolean(current.reminders ?? true)
      : boolean(input.reminders, "settings.reminders")
  };
}
