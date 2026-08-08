import { getAuthenticatedUser } from "./_lib/auth.js";
import { getDb } from "./_lib/db.js";
import { ApiError, handleApiError, readJson, requireMethod, requireSameOrigin, sendJson } from "./_lib/http.js";
import { mapDocumentMetadata, mapLoan, mapPayment, mapRecordDetails, mapSettings } from "./_lib/mappers.js";
import {
  monthToDate,
  normalizeLoan,
  normalizeLoanId,
  normalizeMonth,
  normalizeRecord,
  normalizeSettings
} from "./_lib/validation.js";

const METHODS = ["GET", "POST"];

async function getPortfolio(userId) {
  const sql = getDb();
  const [loanRows, paymentRows, settingsRows, documentRows] = await Promise.all([
    sql`
      SELECT *
      FROM loans
      WHERE user_id = ${userId}
      ORDER BY imported DESC, lender ASC, name ASC
    `,
    sql`
      SELECT *
      FROM payments
      WHERE user_id = ${userId}
      ORDER BY period DESC, loan_id ASC
    `,
    sql`
      SELECT *
      FROM settings
      WHERE user_id = ${userId}
      LIMIT 1
    `,
    sql`
      SELECT id, filename, content_type, byte_size, content_sha256, source_date,
             metadata, blob_url, blob_pathname, created_at, updated_at,
             (content IS NOT NULL) AS has_content,
             (extracted_text IS NOT NULL AND extracted_text <> '') AS has_extracted_text
      FROM source_documents
      WHERE user_id = ${userId}
      ORDER BY created_at DESC, filename ASC
    `
  ]);

  const records = {};
  for (const row of loanRows) {
    const record = mapRecordDetails(row);
    if (Array.isArray(record.sourceFiles) && Array.isArray(record.sections)) records[row.id] = record;
  }

  return {
    loans: loanRows.map(mapLoan),
    records,
    payments: paymentRows.map(mapPayment),
    settings: mapSettings(settingsRows[0]),
    documents: documentRows.map(mapDocumentMetadata)
  };
}

async function verifyDocumentOwnership(sql, userId, documentId) {
  if (!documentId) return;
  const rows = await sql`
    SELECT id FROM source_documents
    WHERE id = ${documentId} AND user_id = ${userId}
    LIMIT 1
  `;
  if (!rows[0]) throw new ApiError(422, "The selected source document does not exist.", "validation_error");
}

async function upsertLoan(userId, body) {
  const sql = getDb();
  const loan = normalizeLoan(body.loan);
  const record = normalizeRecord(body.record);
  await verifyDocumentOwnership(sql, userId, loan.sourceDocumentId);

  let recordDetails = record;
  if (!recordDetails) {
    const existingRows = await sql`
      SELECT record_details
      FROM loans
      WHERE id = ${loan.id} AND user_id = ${userId}
      LIMIT 1
    `;
    recordDetails = existingRows[0]?.record_details || {};
  }

  const detailsJson = JSON.stringify(loan.details);
  const recordJson = JSON.stringify(recordDetails);
  const rows = await sql`
    INSERT INTO loans (
      id, user_id, name, lender, category, repayment_type,
      original_principal, outstanding_principal, monthly_payment,
      annual_interest_rate, fixed_monthly_interest, due_day,
      start_month, end_month, base_month, paid_through,
      auto_pay, active, source_label, note, imported, details,
      record_details, source_document_id
    ) VALUES (
      ${loan.id}, ${userId}, ${loan.name}, ${loan.lender}, ${loan.category}, ${loan.repaymentType},
      ${loan.original}, ${loan.outstanding}, ${loan.emi},
      ${loan.rate}, ${loan.fixedInterest}, ${loan.dueDay},
      ${monthToDate(loan.start)}, ${monthToDate(loan.end)}, ${monthToDate(loan.baseMonth)},
      ${loan.paidThrough ? monthToDate(loan.paidThrough) : null},
      ${loan.autoPay}, ${loan.active}, ${loan.source}, ${loan.note}, ${loan.imported},
      ${detailsJson}::jsonb, ${recordJson}::jsonb, ${loan.sourceDocumentId}
    )
    ON CONFLICT (id) DO UPDATE SET
      name = EXCLUDED.name,
      lender = EXCLUDED.lender,
      category = EXCLUDED.category,
      repayment_type = EXCLUDED.repayment_type,
      original_principal = EXCLUDED.original_principal,
      outstanding_principal = EXCLUDED.outstanding_principal,
      monthly_payment = EXCLUDED.monthly_payment,
      annual_interest_rate = EXCLUDED.annual_interest_rate,
      fixed_monthly_interest = EXCLUDED.fixed_monthly_interest,
      due_day = EXCLUDED.due_day,
      start_month = EXCLUDED.start_month,
      end_month = EXCLUDED.end_month,
      base_month = EXCLUDED.base_month,
      paid_through = EXCLUDED.paid_through,
      auto_pay = EXCLUDED.auto_pay,
      active = EXCLUDED.active,
      source_label = EXCLUDED.source_label,
      note = EXCLUDED.note,
      imported = EXCLUDED.imported,
      details = EXCLUDED.details,
      record_details = EXCLUDED.record_details,
      source_document_id = EXCLUDED.source_document_id,
      updated_at = now()
    WHERE loans.user_id = ${userId}
    RETURNING *
  `;

  if (!rows[0]) throw new ApiError(409, "A loan with this identifier already exists.", "loan_conflict");
  return { loan: mapLoan(rows[0]), record: mapRecordDetails(rows[0]) };
}

async function deleteLoan(userId, body) {
  const loanId = normalizeLoanId(body.loanId);
  const sql = getDb();
  const rows = await sql`
    DELETE FROM loans
    WHERE id = ${loanId} AND user_id = ${userId}
    RETURNING id
  `;
  if (!rows[0]) throw new ApiError(404, "Loan not found.", "not_found");
  return { ok: true, loanId };
}

async function setPayment(userId, body) {
  const loanId = normalizeLoanId(body.loanId);
  const month = normalizeMonth(body.month);
  if (typeof body.paid !== "boolean") throw new ApiError(422, "paid must be true or false.", "validation_error");

  const sql = getDb();
  const loanRows = await sql`
    SELECT monthly_payment, due_day
    FROM loans
    WHERE id = ${loanId} AND user_id = ${userId}
    LIMIT 1
  `;
  const loan = loanRows[0];
  if (!loan) throw new ApiError(404, "Loan not found.", "not_found");

  const [year, monthNumber] = month.split("-").map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const dueDate = `${month}-${String(Math.min(Number(loan.due_day), lastDay)).padStart(2, "0")}`;
  const rows = await sql`
    INSERT INTO payments (user_id, loan_id, period, paid, amount, due_date, paid_at)
    VALUES (
      ${userId}, ${loanId}, ${monthToDate(month)}, ${body.paid},
      ${loan.monthly_payment}, ${dueDate}, ${body.paid ? new Date().toISOString() : null}
    )
    ON CONFLICT (user_id, loan_id, period) DO UPDATE SET
      paid = EXCLUDED.paid,
      amount = EXCLUDED.amount,
      due_date = EXCLUDED.due_date,
      paid_at = CASE
        WHEN EXCLUDED.paid THEN COALESCE(payments.paid_at, EXCLUDED.paid_at)
        ELSE NULL
      END,
      updated_at = now()
    RETURNING *
  `;
  return { payment: mapPayment(rows[0]) };
}

async function updateSettings(userId, body) {
  const sql = getDb();
  const existingRows = await sql`
    SELECT * FROM settings
    WHERE user_id = ${userId}
    LIMIT 1
  `;
  const settings = normalizeSettings(body.settings, mapSettings(existingRows[0]));
  const rows = await sql`
    INSERT INTO settings (
      user_id, monthly_income, reported_monthly_outflow, currency,
      timezone, theme, monthly_roll, reminders
    ) VALUES (
      ${userId}, ${settings.monthlyIncome}, ${settings.reportedMonthlyOutflow},
      ${settings.currency}, ${settings.timezone}, ${settings.theme},
      ${settings.monthlyRoll}, ${settings.reminders}
    )
    ON CONFLICT (user_id) DO UPDATE SET
      monthly_income = EXCLUDED.monthly_income,
      reported_monthly_outflow = EXCLUDED.reported_monthly_outflow,
      currency = EXCLUDED.currency,
      timezone = EXCLUDED.timezone,
      theme = EXCLUDED.theme,
      monthly_roll = EXCLUDED.monthly_roll,
      reminders = EXCLUDED.reminders,
      updated_at = now()
    RETURNING *
  `;
  return { settings: mapSettings(rows[0]) };
}

async function mutatePortfolio(userId, body) {
  switch (body.action) {
    case "upsertLoan": return upsertLoan(userId, body);
    case "deleteLoan": return deleteLoan(userId, body);
    case "setPayment": return setPayment(userId, body);
    case "updateSettings": return updateSettings(userId, body);
    default: throw new ApiError(422, "Unknown data action.", "validation_error");
  }
}

export default async function handler(req, res) {
  try {
    requireMethod(req, METHODS);
    const user = await getAuthenticatedUser(req);
    if (req.method === "GET") {
      sendJson(res, 200, await getPortfolio(user.id));
      return;
    }

    requireSameOrigin(req);
    const body = await readJson(req);
    sendJson(res, 200, await mutatePortfolio(user.id, body));
  } catch (error) {
    handleApiError(res, error, METHODS);
  }
}
