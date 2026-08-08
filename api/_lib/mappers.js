import { dateToMonth } from "./validation.js";
import { isPreviewableContentType } from "./document-security.js";

function numeric(value) {
  return value === null || value === undefined ? null : Number(value);
}

function jsonObject(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function mapLoan(row) {
  return {
    ...jsonObject(row.details),
    id: row.id,
    name: row.name,
    lender: row.lender,
    category: row.category,
    repaymentType: row.repayment_type,
    interestOnly: row.repayment_type === "interest_only",
    original: numeric(row.original_principal),
    outstanding: numeric(row.outstanding_principal),
    emi: numeric(row.monthly_payment),
    rate: numeric(row.annual_interest_rate),
    fixedInterest: numeric(row.fixed_monthly_interest),
    dueDay: numeric(row.due_day),
    start: dateToMonth(row.start_month),
    end: dateToMonth(row.end_month),
    baseMonth: dateToMonth(row.base_month),
    paidThrough: dateToMonth(row.paid_through),
    autoPay: Boolean(row.auto_pay),
    active: Boolean(row.active),
    imported: Boolean(row.imported),
    source: row.source_label,
    note: row.note,
    sourceDocumentId: row.source_document_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function mapRecordDetails(row) {
  return jsonObject(row.record_details);
}

export function mapPayment(row) {
  return {
    id: row.id,
    loanId: row.loan_id,
    month: dateToMonth(row.period),
    paid: Boolean(row.paid),
    amount: numeric(row.amount),
    dueDate: row.due_date,
    paidAt: row.paid_at,
    note: row.note,
    updatedAt: row.updated_at
  };
}

export function mapSettings(row) {
  const theme = row?.theme || "light";
  return {
    monthlyIncome: numeric(row?.monthly_income) ?? 0,
    reportedMonthlyOutflow: numeric(row?.reported_monthly_outflow) ?? 0,
    currency: row?.currency || "INR",
    timezone: row?.timezone || "Asia/Kolkata",
    theme,
    dark: theme === "dark",
    monthlyRoll: row?.monthly_roll ?? true,
    reminders: row?.reminders ?? true,
    updatedAt: row?.updated_at ?? null
  };
}

export function mapDocumentMetadata(row) {
  const hasDatabaseContent = Boolean(row.has_content);
  const hasBlob = Boolean(row.blob_pathname || row.blob_url);
  const hasContent = hasDatabaseContent || hasBlob;
  const previewable = hasContent && isPreviewableContentType(row.content_type);
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    byteSize: Number(row.byte_size || 0),
    sha256: row.content_sha256,
    sourceDate: row.source_date,
    metadata: jsonObject(row.metadata),
    hasContent,
    hasDatabaseContent,
    hasBlob,
    hasExtractedText: Boolean(row.has_extracted_text),
    previewable,
    storage: hasBlob ? "vercel_blob" : hasDatabaseContent ? "neon" : "metadata_only",
    contentUrl: hasContent ? `/api/documents/${row.id}` : null,
    previewUrl: previewable ? `/api/documents/${row.id}?inline=1` : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
